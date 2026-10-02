import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { prepareSandboxManagedRuntime, type SandboxManagedRuntimeClient } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { mergeDirectoryWithBaseline, parseDirectorySnapshot, type LegacySerializedDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { workspacePaths } from "@paperclipai/adapter-utils/workspace-manifest";
import { shouldExcludePath } from "@paperclipai/adapter-utils/exclude-patterns";
import type { Db } from "@paperclipai/db";
import { parseOpenAiManagedProfile, type NativeExecutionInput, type OpenAiManagedProfile } from "../../vendor/paperclip-runner/index.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const ROOT = "/workspace/project";
const EXPORT = "/workspace/paperclip-export.py";
const OUTPUT = "/workspace/outputs/paperclip-workspace.json";
const LIMIT = 200 * 1024 * 1024;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const resourceId = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,512}$/.test(value)) throw new Error("openai_resource_identity_invalid");
  return value;
};
export function openAiWorkspaceRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || /[\\\x00-\x1f]/.test(value) || value.split("/").some((s) => !s || s === "." || s === ".." || s === ".git" || s === ".paperclip-runtime")) {
    throw new Error("openai_workspace_path_denied");
  }
  return value;
}
async function privateJson(file: string, limit = 16 * 1024 * 1024): Promise<any> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit || (stat.mode & 0o077) !== 0) throw new Error("openai_checkpoint_unsafe");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}
async function save(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}`;
  await fs.writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}
async function api(key: string, endpoint: string, init: RequestInit = {}, limit = LIMIT): Promise<Buffer> {
  const response = await fetch(`https://api.openai.com/v1${endpoint}`, {
    ...init, redirect: "error", signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${key}`, "OpenAI-Beta": "agents=v1", ...init.headers },
  });
  if (init.method === "DELETE" && response.status === 404) return Buffer.from("{}");
  if (!response.ok) throw new Error(`openai_hosted_api_http_${response.status}`);
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) { await response.body?.cancel().catch(() => undefined); throw new Error("openai_artifact_too_large"); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function list(key: string, endpoint: string): Promise<any[]> {
  const items: any[] = []; const seen = new Set<string>(); let after = "";
  for (let page = 0; page < 100; page++) {
    const data = JSON.parse((await api(key, `${endpoint}?order=asc&limit=100${after ? `&after=${after}` : ""}`, {}, 8 * 1024 * 1024)).toString());
    if (!Array.isArray(data.data) || data.data.length > 100) throw new Error("openai_artifact_list_invalid");
    items.push(...data.data);
    if (data.has_more === false) return items;
    after = resourceId(data.last_id);
    if (seen.has(after)) throw new Error("openai_artifact_cursor_repeated");
    seen.add(after);
  }
  throw new Error("openai_artifact_list_limit");
}
interface HostedState {
  schema: "paperclip.openai-hosted-workspace.v1";
  binding: NativeExecutionInput["binding"];
  cwd: string;
  profileDigest: string;
  profile: OpenAiManagedProfile;
  baseline: LegacySerializedDirectorySnapshot;
  ignoredPaths: string[];
  uploadedFileIds: string[];
  remoteDeleted?: boolean;
  cleanupError?: string;
  workspaceMerged?: { sessionId: string; turnId: string; artifactsSha256: string; workspaceIdentity: string };
  finalized?: { sessionId: string; turnId: string; artifacts: string[] };
}
// No archive produced by the agent is extracted on the controller. The JSON
// inventory is path/type/size checked before a baseline-aware merge.
export function openAiExportScript(exclude: string[], ignored: string[]): string {
  return `import os, json, base64, stat\nroot=${JSON.stringify(ROOT)}\nexclude=${JSON.stringify(exclude)}\nignored=${JSON.stringify(ignored)}\ndef contains(p,s):\n return s in p.split('/')\ndef match(p,s):\n if s.startswith('*/'): return contains(p,s[2:].removesuffix('/*'))\n if s.endswith('/*'): return p.startswith(s[:-2]+'/')\n return p==s or p.startswith(s+'/')\ndef denied(p):\n return any(match(p,s) for s in exclude+ignored) or contains(p,'.git') or contains(p,'.paperclip-runtime') or contains(p,'.paperclip-inbound')\nentries=[]\nsize=0\ndef walk(d,prefix=''):\n global size\n for name in sorted(os.listdir(d)):\n  rel=prefix+name\n  if denied(rel): continue\n  f=os.path.join(d,name); st=os.lstat(f)\n  if stat.S_ISLNK(st.st_mode): entries.append({'path':rel,'kind':'symlink','target':os.readlink(f)})\n  elif stat.S_ISDIR(st.st_mode):\n   entries.append({'path':rel,'kind':'dir'}); walk(f,rel+'/')\n  elif stat.S_ISREG(st.st_mode):\n   size+=st.st_size\n   if size>100*1024*1024: raise RuntimeError('workspace export exceeds 100 MiB')\n   with open(f,'rb') as stream: data=base64.b64encode(stream.read()).decode('ascii')\n   entries.append({'path':rel,'kind':'file','mode':st.st_mode&0o777,'data':data})\n  else: raise RuntimeError('unsupported workspace entry')\n  if len(entries)>100000: raise RuntimeError('workspace export exceeds entry limit')\nwalk(root)\nos.makedirs('/workspace/outputs',exist_ok=True)\nwith open(${JSON.stringify(OUTPUT)},'w') as stream: json.dump({'schema':'paperclip.openai-workspace-export.v1','entries':entries},stream)\n`;
}

export async function prepareOpenAiHostedWorkspace(input: { execution: NativeExecutionInput; stateRoot: string; apiKey: string }): Promise<OpenAiManagedProfile | null> {
  const provider = input.execution.provider;
  if (provider.kind !== "openai_managed" || provider.openaiProfile.environment.type !== "openai_hosted") return null;
  if ("executionMode" in input.execution && input.execution.executionMode === "plan") throw new Error("openai_hosted_planning_requires_tools_only_profile");
  if (input.execution.session.lifecyclePolicy.mode !== "per_turn") throw new Error("openai_hosted_requires_per_turn_lifecycle");
  const directory = path.join(input.stateRoot, "openai-hosted");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const statePath = path.join(directory, "state.json");
  const cwd = await fs.realpath(input.execution.workspace.cwd);
  const profileDigest = sha(JSON.stringify(provider.openaiProfile));
  const existing = await privateJson(statePath).catch((error) => { if (error.code === "ENOENT") return null; throw error; }) as HostedState | null;
  if (existing) {
    if (JSON.stringify(existing.binding) !== JSON.stringify(input.execution.binding) || existing.cwd !== cwd || existing.profileDigest !== profileDigest) throw new Error("openai_hosted_workspace_binding_changed");
    return parseOpenAiManagedProfile(existing.profile);
  }
  // A coding run must own an isolated Git worktree, not the user's main checkout.
  if (!(await fs.lstat(path.join(cwd, ".git"))).isFile()) throw new Error("openai_hosted_requires_isolated_task_worktree");
  const files: NonNullable<Extract<OpenAiManagedProfile["environment"], { type: "openai_hosted" }>["files"]> = [];
  const commands: { command: string; cwd?: string }[] = [];
  // A previous staging attempt can fail after Files API upload but before the
  // profile checkpoint exists. Reconcile its recorded inputs before retrying.
  const uploadsPath = path.join(directory, "uploads.json");
  const orphaned = await privateJson(uploadsPath).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  if (!Array.isArray(orphaned) || orphaned.length > 50) throw new Error("openai_upload_checkpoint_invalid");
  for (const fileId of orphaned) await api(input.apiKey, `/files/${resourceId(fileId)}`, { method: "DELETE" });
  await save(uploadsPath, []);
  const uploadedFileIds: string[] = [];
  let inlineBytes = 0;
  const add = async (destination: string, bytes: Buffer) => {
    if (!destination.startsWith("/workspace/") || bytes.length > 50 * 1024 * 1024 || files.length >= 49) throw new Error("openai_hosted_input_limit");
    if (bytes.length <= 256 * 1024 && inlineBytes + bytes.length <= 1024 * 1024) {
      files.push({ type: "inline", path: destination, data: bytes.toString("base64") }); inlineBytes += bytes.length;
    } else {
      const body = new FormData(); body.set("purpose", "user_data");
      body.set("file", new Blob([new Uint8Array(bytes)]), path.posix.basename(destination));
      const uploaded = JSON.parse((await api(input.apiKey, "/files", { method: "POST", body }, 1024 * 1024)).toString());
      const fileId = resourceId(uploaded.id); uploadedFileIds.push(fileId);
      await save(path.join(directory, "uploads.json"), uploadedFileIds);
      files.push({ type: "file_id", path: destination, file_id: fileId });
    }
  };
  const unsupported = async (): Promise<never> => { throw new Error("openai_hosted_staging_operation_unsupported"); };
  const client: SandboxManagedRuntimeClient = {
    makeDir: async (remotePath) => { commands.push({ command: `mkdir -p '${remotePath.replaceAll("'", "'\\''")}'` }); },
    writeFile: async (remotePath, bytes) => add(remotePath, Buffer.from(bytes)),
    readFile: unsupported, listFiles: unsupported, remove: unsupported, run: async (command) => { commands.push({ command }); },
    syncIn: async (operations) => {
      const results = [];
      for (const operation of operations) {
        let bytesTransferred = 0;
        for (const file of operation.files) {
          if (file.kind !== "file") throw new Error("openai_hosted_staging_requires_file_mapping");
          const bytes = await fs.readFile(file.sourcePath); await add(file.targetPath, bytes); bytesTransferred += bytes.length;
        }
        commands.push(...(operation.postUploadCommands ?? []).map(({ command, cwd }) => ({ command, ...(cwd ? { cwd } : {}) })));
        results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred });
      }
      return { operations: results };
    },
  };
  const context = "runtimeContext" in input.execution ? input.execution.runtimeContext : null;
  const prepared = await prepareSandboxManagedRuntime({
    spec: { transport: "sandbox", provider: "openai", sandboxId: input.execution.binding.runId, remoteCwd: ROOT, timeoutMs: 120_000, apiKey: null },
    adapterKey: "openai-hosted", client, workspaceLocalDir: cwd,
    assets: context ? [
      { key: "instructions", localDir: context.instructions.bundle.rootPath, followSymlinks: false },
      ...context.skills.map((skill, index) => ({ key: `skill-${index}`, localDir: skill.bundle.rootPath, followSymlinks: false })),
    ] : [],
  });
  try {
    const baseline = prepared.workspaceSyncSnapshot?.baseline;
    if (!baseline || baseline.entries.size > 100_000) throw new Error("openai_hosted_workspace_baseline_unavailable");
    const exclude = [...baseline.exclude, "*/.git", ".git", "*/.paperclip-runtime", ".paperclip-inbound"];
    const ignoredPaths = baseline.ignoredPaths ? [...workspacePaths(baseline.ignoredPaths)] : [];
    const serialized: LegacySerializedDirectorySnapshot = { version: 1, exclude, entries: [...baseline.entries].filter(([p]) => !shouldExcludePath(p, exclude)) };
    await add(EXPORT, Buffer.from(openAiExportScript(exclude, ignoredPaths)));
    const profile = parseOpenAiManagedProfile({ ...provider.openaiProfile, environment: {
      ...provider.openaiProfile.environment, files: [...(provider.openaiProfile.environment.files ?? []), ...files],
      setup_commands: [...commands, ...(provider.openaiProfile.environment.setup_commands ?? [])],
    } });
    await save(statePath, { schema: "paperclip.openai-hosted-workspace.v1", binding: input.execution.binding, cwd, profileDigest, profile, baseline: serialized, ignoredPaths, uploadedFileIds } satisfies HostedState);
    return profile;
  } finally { await prepared.cleanupWorkspaceSnapshot(); }
}

export async function materializeOpenAiWorkspace(bytes: Buffer, destination: string, baseline: LegacySerializedDirectorySnapshot) {
  if (bytes.length > LIMIT) throw new Error("openai_workspace_export_too_large");
  const exported = JSON.parse(bytes.toString());
  if (exported.schema !== "paperclip.openai-workspace-export.v1" || !Array.isArray(exported.entries) || exported.entries.length > 100_000) throw new Error("openai_workspace_export_invalid");
  const entries = new Map<string, any>(); let total = 0;
  const prior = new Map(baseline.entries);
  for (const entry of exported.entries) {
    const relative = openAiWorkspaceRelativePath(entry.path);
    if (entries.has(relative) || shouldExcludePath(relative, baseline.exclude)) throw new Error("openai_workspace_export_path_conflict");
    if (entry.kind === "file") {
      if (typeof entry.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data) || ![0o644, 0o755, 0o600, 0o700, 0o664, 0o775].includes(entry.mode)) throw new Error("openai_workspace_file_invalid");
      total += Buffer.byteLength(entry.data, "base64");
      if (total > 100 * 1024 * 1024) throw new Error("openai_workspace_export_too_large");
    } else if (entry.kind === "symlink") {
      const before = prior.get(relative);
      if (before?.kind !== "symlink" || before.target !== entry.target) throw new Error("openai_workspace_symlink_change_denied");
    } else if (entry.kind !== "dir") throw new Error("openai_workspace_entry_invalid");
    entries.set(relative, entry);
  }
  for (const relative of entries.keys()) {
    const parents = relative.split("/"); parents.pop();
    while (parents.length) {
      if (entries.get(parents.join("/"))?.kind !== "dir") throw new Error("openai_workspace_parent_invalid");
      parents.pop();
    }
  }
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const [relative, entry] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.join(destination, relative);
    if (entry.kind === "dir") await fs.mkdir(target, { recursive: true });
    else if (entry.kind === "symlink") await fs.symlink(entry.target, target);
    else await fs.writeFile(target, Buffer.from(entry.data, "base64"), { mode: entry.mode, flag: "wx" });
  }
}

export function openAiArtifactContentType(file: string): string {
  const types: Record<string, string> = { ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown", ".patch": "text/plain", ".diff": "text/plain", ".csv": "text/csv", ".zip": "application/zip", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".html": "text/html", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const type = types[path.posix.extname(file).toLowerCase()];
  if (!type) throw new Error("openai_artifact_unsupported_type: bundle binary deliverables in a ZIP");
  return type;
}

export async function finalizeOpenAiHostedWorkspace(input: { db: Db; execution: NativeExecutionInput; stateRoot: string; apiKey: string }) {
  if (input.execution.provider.kind !== "openai_managed" || input.execution.provider.openaiProfile.environment.type !== "openai_hosted") return;
  const directory = path.join(input.stateRoot, "openai-hosted");
  const state = await privateJson(path.join(directory, "state.json")) as HostedState;
  if (JSON.stringify(state.binding) !== JSON.stringify(input.execution.binding) || state.cwd !== await fs.realpath(input.execution.workspace.cwd)) throw new Error("openai_hosted_workspace_binding_changed");
  const durable = await privateJson(path.join(input.stateRoot, "runner", "managed-provider-state.json"));
  if (durable.runId !== input.execution.binding.runId || durable.descriptor?.kind !== "openai_managed") throw new Error("openai_hosted_session_binding_changed");
  const sessionId = resourceId(durable.providerSessionId);
  const turnId = resourceId(JSON.parse(durable.durableEventCursor).lastTurnId);
  const cleanup = async () => {
    if (state.remoteDeleted && state.uploadedFileIds.length === 0) return;
    try {
      if (!state.remoteDeleted) for (let attempt = 0; attempt < 3; attempt++) {
        try { await api(input.apiKey, `/agents/sessions/${sessionId}`, { method: "DELETE" }); break; }
        catch (error) { if (!(error instanceof Error) || error.message !== "openai_hosted_api_http_409" || attempt === 2) throw error; await new Promise((resolve) => setTimeout(resolve, 500)); }
      }
      state.remoteDeleted = true; delete state.cleanupError;
      while (state.uploadedFileIds.length > 0) {
        await api(input.apiKey, `/files/${resourceId(state.uploadedFileIds[0])}`, { method: "DELETE" });
        state.uploadedFileIds.shift();
        await save(path.join(directory, "state.json"), state);
      }
    } catch { state.cleanupError = "OpenAI cleanup unconfirmed; inspect the retained session and uploaded files"; }
    await save(path.join(directory, "state.json"), state);
    return state.cleanupError;
  };
  if (state.finalized?.sessionId === sessionId && state.finalized.turnId === turnId) return cleanup();
  const artifacts = (await list(input.apiKey, `/agents/sessions/${sessionId}/artifacts`)).filter((item) => item.turn_id === turnId);
  const exports = artifacts.filter((item) => item.path === OUTPUT);
  if (exports.length !== 1) throw new Error("openai_workspace_export_missing_or_ambiguous");
  const downloaded: Array<{ artifact: any; bytes: Buffer }> = []; let total = 0;
  for (const artifact of artifacts) {
    if (typeof artifact.path !== "string" || !artifact.path.startsWith("/workspace/outputs/")) throw new Error("openai_artifact_path_invalid");
    openAiWorkspaceRelativePath(artifact.path.slice("/workspace/outputs/".length));
    const id = resourceId(artifact.id);
    const bytes = await api(input.apiKey, `/agents/sessions/${sessionId}/artifacts/${id}/content`);
    total += bytes.length; if (total > 500 * 1024 * 1024) throw new Error("openai_artifact_batch_too_large");
    await fs.writeFile(path.join(directory, `${id}.artifact`), bytes, { mode: 0o600 });
    downloaded.push({ artifact, bytes });
  }
  const exported = downloaded.find(({ artifact }) => artifact.path === OUTPUT)!;
  const source = await fs.mkdtemp(path.join(directory, "restore-"));
  try {
    await materializeOpenAiWorkspace(exported.bytes, source, state.baseline);
    const baseline = parseDirectorySnapshot(state.baseline);
    if (!baseline) throw new Error("openai_workspace_baseline_invalid");
    baseline.ignoredPaths = state.ignoredPaths;
    // Bind a completed import to immutable output identities and bytes. A
    // publication-only retry must not reapply files that were edited afterward.
    const artifactsSha256 = sha(JSON.stringify(downloaded.map(({ artifact, bytes }) => ({
      id: artifact.id, path: artifact.path, sha256: sha(bytes),
    })).sort((a, b) => a.id.localeCompare(b.id))));
    for (const { artifact } of downloaded) openAiArtifactContentType(artifact.path);
    const workspaceIdentity = async () => {
      const stat = await fs.stat(state.cwd, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
    };
    const publish = async () => {
      for (const { artifact, bytes } of downloaded) {
        const contentRef = openAiWorkspaceRelativePath(artifact.path.slice("/workspace/outputs/".length));
        // Use the existing transactional registration path so attachments retain
        // their audit/idempotency receipt and their generated preparation comment
        // cannot displace the provider's final answer during presentation.
        const authority = new PaperclipRunnerToolAuthority(input.db, {
          ...input.execution.binding, workspaceRoot: "/workspace/outputs", executionTargetKind: "remote", readRemoteWorkspaceFile: async () => bytes,
        });
        await authority.execute({ tool: "register_deliverable", callId: `openai-output:${artifact.id}`,
          arguments: { idempotencyKey: `openai-output:${sessionId}:${artifact.id}`, filename: path.posix.basename(artifact.path), contentType: openAiArtifactContentType(artifact.path), byteSize: bytes.length, sha256: sha(bytes), contentRef, title: `OpenAI output: ${path.posix.basename(artifact.path)}` },
        });
      }
    };
    if (state.workspaceMerged) {
      if (state.workspaceMerged.sessionId !== sessionId || state.workspaceMerged.turnId !== turnId
        || state.workspaceMerged.artifactsSha256 !== artifactsSha256) throw new Error("openai_hosted_merged_outputs_changed");
      if (state.workspaceMerged.workspaceIdentity !== await workspaceIdentity()) throw new Error("openai_hosted_merged_workspace_replaced");
      // A reset in the same worktree is a later operator edit, just like a new
      // commit. The import receipt is historical; never undo later edits here.
      await publish();
    } else {
      await mergeDirectoryWithBaseline({
        baseline, sourceDir: source, targetDir: state.cwd, conflictPolicy: "reject",
        afterApply: async () => {
          state.workspaceMerged = { sessionId, turnId, artifactsSha256, workspaceIdentity: await workspaceIdentity() };
          await save(path.join(directory, "state.json"), state);
          await publish();
        },
      });
    }
    state.finalized = { sessionId, turnId, artifacts: downloaded.map(({ artifact }) => artifact.id) };
    await save(path.join(directory, "state.json"), state);
    return await cleanup();
  } finally { await fs.rm(source, { recursive: true, force: true }); }
}
