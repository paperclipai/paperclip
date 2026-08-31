import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  parseNativeRuntimeContext,
  type NativeRuntimeAssetReference,
  type NativeRuntimeContextSnapshot,
} from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { agentInstructionsService } from "../agent-instructions.js";
import { toolAccessService } from "../tool-access.js";

export const LEGACY_PAPERCLIP_OPERATIONAL_SKILL_KEY = "paperclipai/paperclip/paperclip" as const;
const MAX_ASSET_FILES = 10_000;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
type RuntimeAgent = { id: string; companyId: string; name: string; adapterType?: string | null; adapterConfig: unknown };
type AssetFile = { path: string; content: Buffer; mode: number };

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const safeRelativePath = (value: string, label: string) => {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must stay within its bundle root`);
  }
  return normalized;
};

async function collectDirectoryFiles(sourceRoot: string): Promise<AssetFile[]> {
  const root = path.resolve(sourceRoot);
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`runtime context source is not a safe directory: ${root}`);
  const files: AssetFile[] = [];
  let totalBytes = 0;
  async function visit(relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(relativeDirectory ? path.join(root, relativeDirectory) : root, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relativePath = safeRelativePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name, "runtime context path");
      const absolutePath = path.join(root, relativePath);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`runtime context bundles do not permit symlinks: ${relativePath}`);
      if (stat.isDirectory()) { await visit(relativePath); continue; }
      if (!stat.isFile()) throw new Error(`runtime context bundle contains an unsupported file: ${relativePath}`);
      const content = await fs.readFile(absolutePath);
      totalBytes += content.byteLength;
      if (files.length + 1 > MAX_ASSET_FILES || totalBytes > MAX_ASSET_BYTES) throw new Error("runtime context bundle exceeds its bound");
      files.push({ path: relativePath, content, mode: stat.mode & 0o555 });
    }
  }
  await visit("");
  if (!files.length) throw new Error(`runtime context source is empty: ${root}`);
  return files;
}

async function makeDirectoriesReadOnly(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesReadOnly(path.join(directory, entry.name));
  }
  await fs.chmod(directory, 0o555);
}

async function verifyMaterializedAsset(
  rootPath: string,
  manifestFiles: Array<{ path: string; sha256: string; mode: number; size: number }>,
): Promise<void> {
  const actual = await collectDirectoryFiles(rootPath);
  const actualByPath = new Map(actual.map((file) => [file.path, file]));
  if (actualByPath.size !== manifestFiles.length) throw new Error("runtime context asset file count mismatch");
  for (const expected of manifestFiles) {
    const file = actualByPath.get(expected.path);
    if (!file || file.content.byteLength !== expected.size || sha256(file.content) !== expected.sha256 || (file.mode & 0o555) !== expected.mode) {
      throw new Error(`runtime context asset digest mismatch: ${expected.path}`);
    }
  }
}

async function materializeAsset(files: AssetFile[]): Promise<NativeRuntimeAssetReference> {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const manifestFiles = sorted.map((file) => ({ path: safeRelativePath(file.path, "runtime context path"), sha256: sha256(file.content), mode: file.mode & 0o555, size: file.content.byteLength }));
  const totalBytes = manifestFiles.reduce((sum, file) => sum + file.size, 0);
  if (!manifestFiles.length || manifestFiles.length > MAX_ASSET_FILES || totalBytes > MAX_ASSET_BYTES) throw new Error("runtime context bundle is empty or exceeds its bound");
  const assetDigest = sha256(JSON.stringify(manifestFiles));
  const manifestText = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest: assetDigest, fileCount: manifestFiles.length, totalBytes, files: manifestFiles })}\n`;
  const manifestDigest = sha256(manifestText);
  const assetsRoot = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets");
  const rootPath = path.join(assetsRoot, "bundles", assetDigest);
  const manifestPath = path.join(assetsRoot, "manifests", `${assetDigest}.json`);
  const existing = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (existing !== null) {
    if (sha256(existing) !== manifestDigest || !(await fs.stat(rootPath).catch(() => null))?.isDirectory()) throw new Error(`runtime context asset verification failed: ${assetDigest}`);
    await verifyMaterializedAsset(rootPath, manifestFiles);
    return { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: assetDigest, manifestDigest, rootPath, fileCount: manifestFiles.length, totalBytes };
  }
  const stagingRoot = path.join(assetsRoot, ".staging", randomUUID());
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  try {
    for (const file of sorted) {
      const target = path.join(stagingRoot, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, file.content, { mode: file.mode & 0o555 });
      await fs.chmod(target, file.mode & 0o555);
    }
    await fs.mkdir(path.dirname(rootPath), { recursive: true, mode: 0o700 });
    let publishedRoot = false;
    await fs.rename(stagingRoot, rootPath).then(() => {
      publishedRoot = true;
    }).catch(async (error: NodeJS.ErrnoException) => {
      // Concurrent publishers can surface EACCES on macOS when the winning
      // destination has already been made read-only. Treat that as a race only
      // when the content-addressed destination now exists; a genuine permission
      // failure with no published destination must still fail loudly.
      const publishedByPeer = (await fs.stat(rootPath).catch(() => null))?.isDirectory() === true;
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY" && !publishedByPeer) throw error;
      await fs.rm(stagingRoot, { recursive: true, force: true });
    });
    // Publish the writable staging directory first. Renaming a read-only
    // directory can fail with EACCES on macOS even when both parents are owned
    // and writable. Files are already immutable; directories become immutable
    // immediately after this process wins publication.
    if (publishedRoot) await makeDirectoriesReadOnly(rootPath);
    await fs.mkdir(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(manifestPath, manifestText, { flag: "wx", mode: 0o400 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      if (sha256(await fs.readFile(manifestPath, "utf8")) !== manifestDigest) throw new Error(`runtime context manifest race mismatch: ${assetDigest}`);
    });
    await verifyMaterializedAsset(rootPath, manifestFiles);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: assetDigest, manifestDigest, rootPath, fileCount: manifestFiles.length, totalBytes };
}

async function materializeInstructionBundle(agent: RuntimeAgent) {
  const exported = await agentInstructionsService().exportFiles(agent, { rejectSymlinks: true });
  const entryPath = safeRelativePath(exported.entryFile, "instruction entry path");
  if (!(entryPath in exported.files)) throw new Error(`configured instruction entry is missing: ${entryPath}`);
  const files = Object.entries(exported.files).map(([relativePath, content]) => ({ path: safeRelativePath(relativePath, "instruction path"), content: Buffer.from(content, "utf8"), mode: 0o444 }));
  return { entryPath, bundle: await materializeAsset(files) };
}

async function materializeSelectedSkills(runtimeConfig: Record<string, unknown>, entries: PaperclipSkillEntry[], rejectLegacy: boolean) {
  const desiredKeys = resolvePaperclipDesiredSkillNames(runtimeConfig, entries);
  if (rejectLegacy && desiredKeys.includes(LEGACY_PAPERCLIP_OPERATIONAL_SKILL_KEY)) throw new Error(`paperclip_runner does not support legacy operational skill ${LEGACY_PAPERCLIP_OPERATIONAL_SKILL_KEY}; remove it from this agent`);
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return Promise.all(desiredKeys.sort().map(async (key) => {
    const entry = byKey.get(key);
    if (!entry) throw new Error(`assigned runtime skill is missing from the company library: ${key}`);
    if (entry.sourceStatus === "missing") throw new Error(entry.missingDetail ?? `assigned runtime skill source is missing: ${key}`);
    return { key: entry.key, runtimeName: safeRelativePath(entry.runtimeName, `runtime name for ${key}`), versionId: entry.versionId ?? entry.currentVersionId ?? null, bundle: await materializeAsset(await collectDirectoryFiles(entry.source)) };
  }));
}

export async function resolveNativeRuntimeMcpSnapshot(input: { db: Db; agent: Pick<RuntimeAgent, "id" | "companyId">; runId: string }) {
  const effective = await toolAccessService(input.db).getEffectiveProfilesForAgent(input.agent.companyId, input.agent.id);
  const permitted = new Set([...effective.entries.filter((entry) => entry.effect === "include" && entry.connectionId).map((entry) => entry.connectionId!), ...effective.allowedTools.map((tool) => tool.connectionId)]);
  const unhealthy = effective.installedConnections.filter((connection) =>
    permitted.has(connection.id)
    && ["mcp_remote", "local_stdio"].includes(connection.transport)
    && (!connection.enabled || connection.status !== "active" || ["degraded", "failed", "error", "missing_secret"].includes(connection.healthStatus)),
  );
  if (unhealthy.length) throw new Error(`assigned native MCP connection is unavailable: ${unhealthy.map((connection) => connection.id).join(", ")}`);
  const assignment = {
    version: 1,
    agentId: input.agent.id,
    connections: effective.installedConnections.filter((connection) => permitted.has(connection.id) && connection.status === "active" && connection.enabled && ["mcp_remote", "local_stdio"].includes(connection.transport)).map((connection) => connection.id).sort(),
    tools: effective.allowedTools.map((tool) => tool.id).sort(),
  };
  const assignmentDigest = sha256(JSON.stringify(assignment));
  return { assignmentSetId: `sha256:${assignmentDigest}`, digest: assignmentDigest, bindingId: assignment.connections.length ? `native-mcp:${input.runId}` : null };
}

export async function buildNativeRuntimeContext(input: { db: Db; agent: RuntimeAgent; runId: string; runtimeConfig: Record<string, unknown>; runtimeSkillEntries: PaperclipSkillEntry[] }): Promise<NativeRuntimeContextSnapshot> {
  const [instructions, skills, mcp] = await Promise.all([
    materializeInstructionBundle(input.agent),
    materializeSelectedSkills(input.runtimeConfig, input.runtimeSkillEntries, input.agent.adapterType === "paperclip_runner"),
    resolveNativeRuntimeMcpSnapshot({ db: input.db, agent: input.agent, runId: input.runId }),
  ]);
  const snapshot = { prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() }, instructions, skills, mcp };
  return parseNativeRuntimeContext({ ...snapshot, aggregateDigest: canonicalNativeRuntimeContextDigest(snapshot) });
}
