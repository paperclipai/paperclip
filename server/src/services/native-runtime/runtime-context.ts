import { skillExecutionContent } from "../skill-execution-content.js";
import { withRuntimeAssetUse, removeRuntimeAssetTree } from "./runtime-asset-retention.js";
import { cachedSkillAsset, rememberSkillAsset } from "./skill-asset-cache.js";
import { verifyFileManifest, type FileManifestEntry } from "../file-manifest-cache.js";
import { measureRunPhase } from "../execution-preparation-timing.js";
import { spekoToolsForSession } from "../voice/speko-agent-tools.js";
import { githubBotConnectionIdsForRun } from "../chat-github-tools.js";
import { boundRunIssueIdSql } from "../run-task-binding.js";
import { isBrowserUseConnection } from "../browser-use-client.js";
import { restConnectorFor } from "../connectors/rest-registry.js";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { companySkillVersions, heartbeatRuns, type Db } from "@paperclipai/db";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import { isToolConnectionAttentionHealth } from "@paperclipai/shared";
import {
  PAPERCLIP_OPERATIONAL_SKILL_KEY,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
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
import { agentInstructionsService, agentInstructionsBundleMode } from "../agent-instructions.js";
import { agentInstructionRevisionService } from "../agent-instruction-revisions.js";
import { toolAccessService } from "../tool-access.js";
import { filterResolvedGitHubConnectionsForRun } from "../git-credentials.js";

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
  const expected = manifestFiles.map(file => ({ ...file, executable: Boolean(file.mode & 0o111) }));
  if (!await measureRunPhase("runtime_context.asset_read", () => verifyFileManifest(rootPath, expected))) {
    throw new Error("runtime context asset digest mismatch");
  }
}

export async function materializeAsset(files: AssetFile[]): Promise<NativeRuntimeAssetReference> {
  const { sorted, manifestFiles, totalBytes, assetDigest, manifestText, manifestDigest } = await measureRunPhase("runtime_context.asset_manifest", () => {
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
    const manifestFiles = sorted.map((file) => ({ path: safeRelativePath(file.path, "runtime context path"), sha256: sha256(file.content), mode: file.mode & 0o555, size: file.content.byteLength }));
    const totalBytes = manifestFiles.reduce((sum, file) => sum + file.size, 0);
    if (!manifestFiles.length || manifestFiles.length > MAX_ASSET_FILES || totalBytes > MAX_ASSET_BYTES) throw new Error("runtime context bundle is empty or exceeds its bound");
    const assetDigest = sha256(JSON.stringify(manifestFiles));
    const manifestText = `${JSON.stringify({ schema: "paperclip.runtime-asset-manifest.v1", digest: assetDigest, fileCount: manifestFiles.length, totalBytes, files: manifestFiles })}\n`;
    const manifestDigest = sha256(manifestText);
    return { sorted, manifestFiles, totalBytes, assetDigest, manifestText, manifestDigest };
  });
  return withRuntimeAssetUse(assetDigest, async function publishOrReuse(locked): Promise<NativeRuntimeAssetReference> {
    const assetsRoot = path.join(resolvePaperclipInstanceRoot(), "runtime-context-assets");
    const rootPath = path.join(assetsRoot, "bundles", assetDigest);
    const manifestPath = path.join(assetsRoot, "manifests", `${assetDigest}.json`);
    const existing = await measureRunPhase("runtime_context.asset_cache", () => fs.readFile(manifestPath, "utf8").catch(() => null));
    const rootExists = (await fs.stat(rootPath).catch(() => null))?.isDirectory();
    if (existing !== null && rootExists && sha256(existing) === manifestDigest
      && await verifyFileManifest(rootPath, manifestFiles.map(file => ({ ...file, executable: Boolean(file.mode & 0o111) })))) {
      return { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: assetDigest, manifestDigest, rootPath, fileCount: manifestFiles.length, totalBytes };
    }
    if (!locked) return withRuntimeAssetUse(assetDigest, publishOrReuse, true);
    // The caller supplied the exact authoritative bytes for this digest. A missing
    // or damaged disposable copy can be rebuilt under the publication/GC lock.
    if (rootExists) await removeRuntimeAssetTree(rootPath);
    await fs.rm(manifestPath, { force: true });
    await measureRunPhase("runtime_context.asset_materialize", async () => {
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
          if (sha256(await measureRunPhase("runtime_context.asset_cache", () => fs.readFile(manifestPath, "utf8"))) !== manifestDigest) throw new Error(`runtime context manifest race mismatch: ${assetDigest}`);
        });
        await measureRunPhase("runtime_context.asset_verify", () => verifyMaterializedAsset(rootPath, manifestFiles), { fileCount: manifestFiles.length, bytes: totalBytes });
      } catch (error) {
        await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }, { fileCount: manifestFiles.length, bytes: totalBytes });
    return { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest: assetDigest, manifestDigest, rootPath, fileCount: manifestFiles.length, totalBytes };
  });
}

async function materializeInstructionBundle(db: Db, agent: RuntimeAgent, agentFiles = false) {
  if (agentFiles) {
    const current = await agentInstructionRevisionService(db).readCommittedForRuntime({ companyId: agent.companyId, agentId: agent.id });
    if (!current) throw new Error("Configured instruction entry is missing");
    const entryPath = safeRelativePath(current.revision.entryFile, "instruction entry path");
    return { entryPath, bundle: await materializeAsset([{ path: entryPath, content: Buffer.from(current.content, "utf8"), mode: 0o444 }]) };
  }
  const exported = await agentInstructionsService(db).exportFiles(agent, { rejectSymlinks: true });
  if (agentInstructionsBundleMode(agent) === "managed") {
    // The database head remains authoritative when a saved revision could not
    // update its disk projection. Overlay the exact committed snapshot directly;
    // a repair followed by a separate export can race another pending commit.
    const current = await agentInstructionRevisionService(db).readCommittedForRuntime({ companyId: agent.companyId, agentId: agent.id });
    if (current) {
      exported.entryFile = current.revision.entryFile;
      exported.files[current.revision.entryFile] = current.content;
    }
  }
  const entryPath = safeRelativePath(exported.entryFile, "instruction entry path");
  if (!(entryPath in exported.files)) throw new Error(`configured instruction entry is missing: ${entryPath}`);
  const files = Object.entries(exported.files).map(([relativePath, content]) => ({ path: safeRelativePath(relativePath, "instruction path"), content: Buffer.from(content, "utf8"), mode: 0o444 }));
  return { entryPath, bundle: await materializeAsset(files) };
}

async function materializeSkillAsset(source: string) {
    let bundle = await measureRunPhase("runtime_context.asset_verify", () => cachedSkillAsset(source));
    if (!bundle) {
      const files = await measureRunPhase("runtime_context.asset_read", () => collectDirectoryFiles(source));
      bundle = await materializeAsset(files);
      const manifest: FileManifestEntry[] = files.map(file => ({ path: file.path, size: file.content.length,
        sha256: sha256(file.content), mode: file.mode & 0o555, executable: Boolean(file.mode & 0o111) }));
      if (await verifyFileManifest(source, manifest)) rememberSkillAsset(source, manifest, bundle);
    }
    return bundle;
}

export async function rehydratePinnedSkillAssets(
  db: Db,
  binding: { companyId: string; runId: string; agentId: string },
  context: NativeRuntimeContextSnapshot,
): Promise<NativeRuntimeContextSnapshot> {
  if (!context.skills.some(skill => skill.versionId)) return context;
  const [run] = await db.select({ responsibleUserId: heartbeatRuns.responsibleUserId,
    contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.agentId, binding.agentId)));
  if (!run) throw new Error("Skill recovery has no matching admitted run");
  const actor = { type: "agent" as const, companyId: binding.companyId, agentId: binding.agentId,
    runId: binding.runId, source: "agent_jwt" as const,
    onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId };
  const delivery = skillExecutionContent(db, { actor });
  const pins = run.contextSnapshot?.skillVersions;
  const skills: NativeRuntimeContextSnapshot["skills"] = [];
  for (const skill of context.skills) {
    if (!skill.versionId) { skills.push(skill); continue; }
    if (pins !== undefined && (!pins || typeof pins !== "object" || Array.isArray(pins)
      || (pins as Record<string, unknown>)[skill.key] !== skill.versionId)) {
      throw new Error("Skill recovery differs from the admitted version selection");
    }
    const [version] = await db.select({ skillId: companySkillVersions.companySkillId }).from(companySkillVersions).where(and(
      eq(companySkillVersions.companyId, binding.companyId), eq(companySkillVersions.id, skill.versionId)));
    if (!version) throw new Error("Pinned skill version is unavailable for recovery");
    const bundle = await delivery.withVersion({ companyId: binding.companyId, skillId: version.skillId, versionId: skill.versionId },
      source => materializeSkillAsset(source));
    if (bundle.digest !== skill.bundle.digest || bundle.manifestDigest !== skill.bundle.manifestDigest
      || bundle.fileCount !== skill.bundle.fileCount || bundle.totalBytes !== skill.bundle.totalBytes) {
      throw new Error("Recovered skill projection does not match its admitted digest");
    }
    skills.push({ ...skill, bundle });
  }
  return { ...context, skills };
}

export async function materializeSelectedSkills(runtimeConfig: Record<string, unknown>, entries: PaperclipSkillEntry[], omitLegacy: boolean) {
  const desiredKeys = resolvePaperclipDesiredSkillNames(runtimeConfig, entries).filter(
    (key) => !omitLegacy || key !== PAPERCLIP_OPERATIONAL_SKILL_KEY,
  );
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return Promise.all(desiredKeys.sort().map(async (key) => {
    const entry = byKey.get(key);
    if (!entry) throw new Error(`assigned runtime skill is missing from the company library: ${key}`);
    if (entry.sourceStatus === "missing") throw new Error(entry.missingDetail ?? `assigned runtime skill source is missing: ${key}`);
    const bundle = await materializeSkillAsset(entry.source);
    return { key: entry.key, runtimeName: safeRelativePath(entry.runtimeName, `runtime name for ${key}`), versionId: entry.versionId ?? entry.currentVersionId ?? null, bundle };
  }));
}

export async function resolveNativeRuntimeMcpSnapshot(input: { db: Db; agent: Pick<RuntimeAgent, "id" | "companyId">; runId: string }) {
  const effective = await toolAccessService(input.db).getEffectiveToolAssignmentsForAgent(input.agent.companyId, input.agent.id);
  const permitted = new Set([...effective.entries.filter((entry) => entry.effect === "include" && entry.connectionId).map((entry) => entry.connectionId!), ...effective.allowedTools.map((tool) => tool.connectionId)]);
  const hasGitHubConnection = effective.installedConnections.some((connection) => {
    const config = connection.config && typeof connection.config === "object"
      ? connection.config as Record<string, unknown>
      : {};
    const transportConfig = connection.transportConfig && typeof connection.transportConfig === "object"
      ? connection.transportConfig as Record<string, unknown>
      : {};
    return config.sourceTemplateKey === "github" || transportConfig.sourceTemplateKey === "github";
  });
  const hasVoiceConnection = effective.installedConnections.some(connection => connection.transport === "voice");
  const [runIdentity] = hasGitHubConnection || hasVoiceConnection
    ? await input.db.select({ issueId: boundRunIssueIdSql(), responsibleUserId: heartbeatRuns.responsibleUserId, activeIdentityContextId: heartbeatRuns.activeIdentityContextId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.agent.companyId),
        eq(heartbeatRuns.agentId, input.agent.id),
      ))
      .limit(1)
    : [];
  // Broker runs pin the permitted tool catalog, not one person’s credential.
  // Selection happens at each operation and can change through steering.
  const resolvedInstalledConnections = runIdentity?.activeIdentityContextId
    ? effective.installedConnections : await filterResolvedGitHubConnectionsForRun({
    db: input.db,
    companyId: input.agent.companyId,
    agentId: input.agent.id,
    responsibleUserId: runIdentity?.responsibleUserId ?? null,
    connections: effective.installedConnections,
  });
  // App access is optional runtime context. Keep usable assignments pinned, but
  // do not stop unrelated work because an assigned app needs attention.
  const githubBotConnectionIds = await githubBotConnectionIdsForRun(input.db, input.agent.companyId, input.agent.id, input.runId);
  const spekoConnectionIds = hasVoiceConnection ? new Set((await spekoToolsForSession(input.db, { companyId: input.agent.companyId, agentId: input.agent.id, runId: input.runId, issueId: runIdentity?.issueId ?? null, identityContextId: runIdentity?.activeIdentityContextId })).map(tool => tool.connectionId)) : new Set<string>();
  const availableConnectionIds = new Set(resolvedInstalledConnections.filter((connection) =>
    permitted.has(connection.id)
    && connection.status === "active"
    && connection.enabled
    && (Boolean(runIdentity?.activeIdentityContextId) && (connection.config?.sourceTemplateKey === "github" || connection.transportConfig?.sourceTemplateKey === "github")
      || connection.credentialPolicy === "per_user"
      || !isToolConnectionAttentionHealth(connection.healthStatus))
    && (["mcp_remote", "local_stdio"].includes(connection.transport) || isBrowserUseConnection(connection) || restConnectorFor(connection) || githubBotConnectionIds.has(connection.id) || spekoConnectionIds.has(connection.id))
  ).map((connection) => connection.id));
  const assignment = {
    version: 1,
    agentId: input.agent.id,
    connections: [...availableConnectionIds].sort(),
    tools: effective.allowedTools
      .filter((tool) => availableConnectionIds.has(tool.connectionId))
      .map((tool) => tool.id)
      .sort(),
  };
  const assignmentDigest = sha256(JSON.stringify(assignment));
  return { assignmentSetId: `sha256:${assignmentDigest}`, digest: assignmentDigest, bindingId: assignment.connections.length ? `native-mcp:${input.runId}` : null };
}

export async function buildNativeRuntimeContext(input: { db: Db; agent: RuntimeAgent; runId: string; runtimeConfig: Record<string, unknown>; runtimeSkillEntries: PaperclipSkillEntry[]; instructionWorkingCopy?: { rootPath: string; entryPath: string; kind?: "agent_files" } }): Promise<NativeRuntimeContextSnapshot> {
  const preconfigured = input.runtimeConfig.homeMode === "preconfigured";
  const emptyMcpDigest = sha256("preconfigured");
  const [instructions, skills, mcp] = await Promise.all([
    measureRunPhase("runtime_context.instructions", () => materializeInstructionBundle(input.db, input.agent, input.instructionWorkingCopy?.kind === "agent_files")),
    measureRunPhase("runtime_context.skills", () => preconfigured ? [] : materializeSelectedSkills(input.runtimeConfig, input.runtimeSkillEntries, input.agent.adapterType === "paperclip_runner")),
    measureRunPhase("runtime_context.mcp", () => preconfigured ? { assignmentSetId: `sha256:${emptyMcpDigest}`, digest: emptyMcpDigest, bindingId: null } : resolveNativeRuntimeMcpSnapshot({ db: input.db, agent: input.agent, runId: input.runId })),
  ]);
  const snapshot = {
    prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
    instructions: { ...instructions, ...(input.instructionWorkingCopy ? { workingCopy: input.instructionWorkingCopy } : {}) },
    skills,
    mcp,
    ...(input.runtimeConfig.paperclipConnectionInstructions ? {
      connectionInstructions: input.runtimeConfig.paperclipConnectionInstructions as { text: string; digest: string },
    } : {}),
  };
  return parseNativeRuntimeContext({ ...snapshot, aggregateDigest: canonicalNativeRuntimeContextDigest(snapshot) });
}
