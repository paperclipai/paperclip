import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessCodexAppServerTransport } from "./app-server-transport.js";
import { resolveCodexCommand } from "./codex-command.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const canonicalCwd = (value: string) => /^[a-z]:[\\/]/i.test(value)
  ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
export type StoppedCodexBinding = { threadId: string; turnId: string; cwd: string };
export type ClosedReadOnlyCodexThread = {
  threadId: string; turnId: string; readOperations: string[];
  /** Saved read calls by provider item id, which is the runner's tool executionId. */
  readCalls: { id: string; tool: string }[];
};

/** A terminal read-only thread has no native tool process or unknown mutation to replay. */
export function proveClosedReadOnlyCodexThread(
  value: unknown, binding: StoppedCodexBinding, readOperations: ReadonlySet<string>,
): ClosedReadOnlyCodexThread | null {
  const thread = record(value);
  if (thread.id !== binding.threadId || typeof thread.cwd !== "string" ||
      canonicalCwd(thread.cwd) !== canonicalCwd(binding.cwd) || !Array.isArray(thread.turns) || !thread.turns.length)
    return null;
  const turns = thread.turns.map(record);
  if (turns.at(-1)?.id !== binding.turnId || turns.at(-1)?.status !== "interrupted") return null;
  const reads = new Set<string>();
  const readCalls: { id: string; tool: string }[] = [];
  const turnIds = new Set<string>();
  for (const turn of turns) {
    if (typeof turn.id !== "string" || !turn.id || turnIds.has(turn.id) ||
        !["completed", "interrupted", "failed"].includes(String(turn.status)) || !Array.isArray(turn.items)) return null;
    turnIds.add(turn.id);
    for (const value of turn.items) {
      const item = record(value);
      if (["userMessage", "agentMessage", "reasoning", "plan"].includes(String(item.type))) continue;
      if (item.type !== "dynamicToolCall" || typeof item.tool !== "string" || !readOperations.has(item.tool) ||
          !["completed", "failed"].includes(String(item.status))) return null;
      reads.add(item.tool);
      if (typeof item.id === "string" && item.id) readCalls.push({ id: item.id, tool: item.tool });
    }
  }
  return { threadId: binding.threadId, turnId: binding.turnId, readOperations: [...reads].sort(), readCalls };
}

export type CodexSourceFile = { path: string; facts: string };
async function fileFacts(file: string, limit: number): Promise<string> {
  const s = await lstat(file, { bigint: true });
  if (!s.isFile() || s.isSymbolicLink() || s.size > BigInt(limit)) throw new Error("codex_cleanup_source_not_regular_or_oversized");
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
}

export async function stoppedCodexSourceUnchanged(files: readonly CodexSourceFile[]): Promise<boolean> {
  try { return files.length > 0 && (await Promise.all(files.map(async file =>
    await fileFacts(file.path, 128 * 1024 * 1024) === file.facts))).every(Boolean); } catch { return false; }
}

/** Read saved protocol history in a disposable home. Never resume a thread or start a turn.
 * No auth, provider config, skills, plugins or credential environment is copied. */
export async function readStoppedCodexThread(input: {
  sourceHome: string; threadId: string; command?: string; args?: string[]; timeoutMs?: number;
}): Promise<{ thread: unknown; sourceFiles: CodexSourceFile[]; sourceIsCurrent: () => boolean; runtimeCommand: string }> {
  const sourceHome = await realpath(input.sourceHome);
  const home = await mkdtemp(path.join(tmpdir(), "pc-thread-read-"));
  const sources: CodexSourceFile[] = [];
  let transport: ProcessCodexAppServerTransport | undefined;
  let failure: unknown;
  const deadline = Date.now() + Math.min(input.timeoutMs ?? 10_000, 30_000);
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("codex_cleanup_probe_timeout")), Math.max(1, deadline - Date.now()));
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  const copy = async (source: string, destination: string) => {
    const facts = await fileFacts(source, 128 * 1024 * 1024);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if (await fileFacts(source, 128 * 1024 * 1024) !== facts) throw new Error("codex_cleanup_source_changed");
    sources.push({ path: source, facts });
  };
  try {
    const runtimeCommand = input.command ?? resolveCodexCommand();
    const names = await readdir(sourceHome);
    if (names.length > 256) throw new Error("codex_cleanup_source_inventory_limit");
    for (const name of names.filter(name => /^(?:state|thread_history)_\d+\.sqlite(?:-wal)?$/.test(name)))
      await copy(path.join(sourceHome, name), path.join(home, name));
    const environment: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "SystemDrive", "LOCALAPPDATA", "TEMP", "TMP", "HOME", "USERPROFILE"])
      if (process.env[key] !== undefined) environment[key] = process.env[key];
    const openReader = async () => {
      transport = new ProcessCodexAppServerTransport({ command: runtimeCommand,
        args: input.args ?? ["app-server"], environment, workingDirectory: home, closeGraceMs: 2_000,
        maxLineBytes: 8 * 1024 * 1024 });
      await bounded(transport.request("initialize", {
        clientInfo: { name: "paperclip_cleanup_reader", version: "1" }, capabilities: { experimentalApi: true },
      }));
      transport.notify("initialized", {});
      return transport;
    };
    transport = await openReader();
    const metadata = record((await bounded(transport.request("thread/read", {
      threadId: input.threadId, includeTurns: false,
    }))).thread);
    if (metadata.id !== input.threadId || typeof metadata.path !== "string") throw new Error("codex_cleanup_thread_unbound");
    const relative = path.relative(home, metadata.path);
    const sourceRelative = relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      ? path.relative(sourceHome, metadata.path) : relative;
    const parts = sourceRelative.split(path.sep);
    if (!["sessions", "archived_sessions"].includes(parts[0]) || parts.some(part => !part || part === "..") ||
        !path.basename(sourceRelative).endsWith(`-${input.threadId}.jsonl`)) throw new Error("codex_cleanup_rollout_unbound");
    const original = path.join(sourceHome, sourceRelative);
    if (await realpath(original) !== original) throw new Error("codex_cleanup_rollout_linked");
    await copy(original, path.join(home, sourceRelative));
    // Metadata discovery can cache an empty thread before its rollout is copied.
    await transport.close();
    if (!transport.processInfo().exited) throw new Error("codex_cleanup_reader_stop_unverified");
    transport = await openReader();
    const result = await bounded(transport.request("thread/read", { threadId: input.threadId, includeTurns: true }));
    if (!await stoppedCodexSourceUnchanged(sources)) throw new Error("codex_cleanup_source_changed");
    return { thread: result.thread, sourceFiles: sources, runtimeCommand, sourceIsCurrent: () => {
      try { return sources.every(file => {
        const s = lstatSync(file.path, { bigint: true });
        return s.isFile() && !s.isSymbolicLink() &&
          [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":") === file.facts;
      }); } catch { return false; }
    } };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await transport?.close();
    if (transport && !transport.processInfo().exited) throw new Error("codex_cleanup_reader_stop_unverified");
    try { await rm(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); }
    catch (cleanup) { throw new AggregateError([...(failure ? [failure] : []), cleanup], "codex_cleanup_reader_failed"); }
  }
}
