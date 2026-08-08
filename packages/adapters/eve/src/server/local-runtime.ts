import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  ensurePathInEnv,
  sanitizeInheritedPaperclipEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { fetchInfo } from "../shared/client.js";

/**
 * Shared project-shape heuristic for eve_local, used by both execute()
 * (hard error before any spawn) and testEnvironment() (warn path) so the
 * two can never drift apart. A directory counts as an Eve project iff it
 * contains `agent/instructions.md` or `agent.ts`.
 */
export function looksLikeEveProject(projectDir: string): boolean {
  return (
    fsSync.existsSync(path.join(projectDir, "agent", "instructions.md")) ||
    fsSync.existsSync(path.join(projectDir, "agent.ts"))
  );
}

export type EveServerHandle = {
  child: ChildProcess;
  pid: number;
  /** Resolves when the child exits (never rejects). */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited: () => boolean;
};

/** Bind to port 0 on 127.0.0.1, read the assigned port, close, return it. */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to allocate a free port.")));
      }
    });
  });
}

function pipeLines(
  stream: NodeJS.ReadableStream | null,
  emit: (line: string) => void,
): void {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim().length > 0) emit(line);
      newlineIndex = buffer.indexOf("\n");
    }
  });
  stream.on("end", () => {
    if (buffer.trim().length > 0) emit(buffer);
  });
}

export async function spawnEveServer(opts: {
  projectDir: string;
  command: string;
  args: string[];
  port: number;
  env: Record<string, string>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
}): Promise<EveServerHandle> {
  const mergedEnv = ensurePathInEnv({
    ...sanitizeInheritedPaperclipEnv(process.env),
    ...opts.env,
    PORT: String(opts.port),
  });

  const child = spawn(opts.command, opts.args, {
    cwd: opts.projectDir,
    env: mergedEnv,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const emitServerLog = (line: string) => {
    void opts.onLog("stderr", `[eve] ${line}\n`).catch(() => {});
  };
  pipeLines(child.stdout, emitServerLog);
  pipeLines(child.stderr, emitServerLog);

  let exitedFlag = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exitedFlag = true;
      resolve({ code, signal });
    });
    child.once("error", () => {
      // If spawn itself fails there is no exit event; treat as exited.
      exitedFlag = true;
      resolve({ code: null, signal: null });
    });
  });

  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(
          new Error(
            `Eve command "${opts.command}" was not found. Install Eve (npm i -g eve) or set the "command" config field to a runnable binary.`,
          ),
        );
      } else {
        reject(new Error(`Failed to start Eve server ("${opts.command}"): ${err.message}`));
      }
    });
  });

  const pid = child.pid ?? -1;
  if (opts.onSpawn && pid > 0) {
    try {
      await opts.onSpawn({ pid, processGroupId: null, startedAt: new Date().toISOString() });
    } catch {
      // Recording spawn metadata is best-effort.
    }
  }

  return {
    child,
    pid,
    exited,
    hasExited: () => exitedFlag,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll GET /eve/v1/info until it answers 2xx or the timeout elapses. */
export async function waitForReady(opts: {
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<void> {
  const pollIntervalMs = opts.pollIntervalMs ?? 500;
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) {
      throw new Error("Aborted while waiting for the Eve server to become ready.");
    }
    try {
      await fetchInfo({ baseUrl: opts.baseUrl, headers: opts.headers, timeoutMs: Math.min(5000, opts.timeoutMs) });
      return;
    } catch (err) {
      lastError = err;
    }
    await sleep(pollIntervalMs);
  }
  const reason = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(
    `Eve server did not become ready within ${opts.timeoutMs}ms (readiness timeout polling ${opts.baseUrl}/eve/v1/info).${reason}`,
  );
}

/**
 * Stop the Eve server child process. Never throws.
 *
 * Platform note: on POSIX we send SIGTERM first and escalate to SIGKILL after
 * graceMs. On win32 `child.kill()` maps to TerminateProcess (forceful, no
 * graceful signal semantics), so we call it once and wait for exit.
 */
export async function stopEveServer(
  handle: EveServerHandle,
  opts: { graceMs?: number } = {},
): Promise<void> {
  const graceMs = opts.graceMs ?? 10_000;
  try {
    if (handle.hasExited()) return;
    if (process.platform === "win32") {
      handle.child.kill();
      await Promise.race([handle.exited, sleep(graceMs)]);
      return;
    }
    handle.child.kill("SIGTERM");
    const terminated = await Promise.race([
      handle.exited.then(() => true),
      sleep(graceMs).then(() => false),
    ]);
    if (!terminated) {
      handle.child.kill("SIGKILL");
      await Promise.race([handle.exited, sleep(5_000)]);
    }
  } catch {
    // Teardown must never throw.
  }
}
