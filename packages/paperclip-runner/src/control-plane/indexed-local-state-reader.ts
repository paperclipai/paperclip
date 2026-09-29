import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { basename, dirname } from "node:path";
import { defaultStorageRunnerBinary, nativeStorageCommand } from "./native-storage-command.js";
import { authorityGeneration } from "./durable-authority-store.js";

let readers = 0;
export interface IndexedLocalSnapshot {
  state: Record<string, unknown>;
  generation: string;
  stateDigest: string;
  preparation: Record<string, unknown> | null;
}

/** Reads one runner-owned current-state row off the JavaScript event loop. */
export function readIndexedLocalState(path: string, options: { runnerBinary?: string; timeoutMs?: number } = {}): Promise<IndexedLocalSnapshot> {
  return localStateJob(path, options);
}

/** Caller must independently fence and prove the runner/process group stopped.
 * Only the exact verified, empty checkpoint can be sealed for cold continuation. */
export async function suspendIndexedRunnerState(path: string, expectedGeneration: string, runnerBinary?: string): Promise<void> {
  if (basename(path) !== "runner-state.json" || expectedGeneration === "0") throw new Error("indexed_state_seal_invalid");
  try { authorityGeneration(expectedGeneration); } catch { throw new Error("indexed_state_seal_invalid"); }
  await nativeStorageCommand(["seal", "--directory", dirname(path), "--generation", expectedGeneration], runnerBinary);
}

async function localStateJob(path: string, options: { runnerBinary?: string; timeoutMs?: number }): Promise<IndexedLocalSnapshot> {
  if (readers >= 4) throw new Error("indexed_state_reader_busy");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("indexed_state_read_timeout_invalid");
  readers += 1;
  let worker: Worker | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    worker = new Worker(new URL(`./indexed-native-state-worker.${extension}`, import.meta.url), { execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128 } });
    child = spawn(options.runnerBinary ?? defaultStorageRunnerBinary(), ["storage", "inspect-state", "--path", path], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: {} });
    closed = new Promise<void>(resolve => child!.once("close", () => resolve()));
    return await new Promise<IndexedLocalSnapshot>((resolve, reject) => {
      let settled = false, stderr = "";
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      timer = setTimeout(() => fail(new Error("indexed_state_read_timeout")), timeoutMs);
      worker!.on("message", (message: { consumed?: boolean; value?: IndexedLocalSnapshot; error?: string }) => {
        if (settled) return;
        if (message.error) fail(new Error(message.error));
        else if (message.value) { settled = true; resolve(message.value); }
        else if (message.consumed) child!.stdout!.resume();
        else fail(new Error("indexed_state_reader_invalid_message"));
      });
      worker!.once("error", fail);
      worker!.once("exit", () => { if (!settled) fail(new Error("indexed_state_reader_exited")); });
      child!.once("error", fail);
      child!.stderr!.on("data", (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString("utf8").slice(0, 8192 - stderr.length); });
      child!.stdout!.on("data", (chunk: Buffer) => {
        // One unconsumed transport chunk at a time; worker message queues must
        // not become a second current-state/history buffer.
        child!.stdout!.pause();
        if (!settled) worker!.postMessage({ bytes: chunk });
      });
      child!.once("close", code => {
        if (settled) return;
        if (code !== 0) fail(new Error(stderr.trim() || "indexed_state_native_reader_failed"));
        else worker!.postMessage({ complete: true });
      });
    });
  } finally {
    if (timer) clearTimeout(timer);
    // A decoder failure or deadline cannot leak a native SQLite reader/lifetime
    // fence. Keep the admission credit until the exact owned child is reaped.
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      // Failure may leave stdout paused with additional bytes in the pipe.
      // Destroy owned streams so unread output cannot delay the close/reap.
      child?.stdout?.destroy(); child?.stderr?.destroy();
      await closed;
    } finally {
      try { await worker?.terminate(); } finally { readers -= 1; }
    }
  }
}
