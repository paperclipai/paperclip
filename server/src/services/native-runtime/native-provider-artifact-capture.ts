import { logger } from "../../middleware/logger.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeProviderArtifactSource } from "./native-provider-artifacts.js";
import type { OpenCodeLaunchArtifacts } from "./remote-opencode-artifacts.js";
import type { NativeExecutionContext } from "./native-execution-context.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";
import { NativeProviderArtifactTransferTimeoutError } from "./native-provider-artifacts.js";
import { isPluginRpcTimeout } from "./remote-runner-recovery-probe.js";

const names = ["nodeCommand", "opencodeProxy", "opencodeExecutable"] as const;
export const NATIVE_PROVIDER_ARTIFACT_PUBLISH_ATTEMPTS = 3;
export const NATIVE_PROVIDER_ARTIFACT_CAPTURE_HEDGE_MS = 90_000;

type Latch = { promise: Promise<void>; resolve: () => void };

function latch(): Latch {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

export type ShareNativeProviderArtifactCaptureInput<T> = {
  key: string;
  signal: AbortSignal;
  reuse: () => Promise<T | null>;
  capture: (signal: AbortSignal, hold: (work: Promise<unknown>) => void) => Promise<T>;
  hedgeAfterMs?: number;
};

const MAX_CONCURRENT_CAPTURES = 2;

class SharedArtifactCapture {
  private readonly state = { saved: false, running: 0, lastStartedAtMs: 0 };
  private changed = latch();

  constructor(private readonly key: string) {}

  get saved() {
    return this.state.saved;
  }

  tryStart(hedgeAfterMs: number, options: { afterSavedMiss: boolean }): (() => void) | null {
    if (this.state.running >= MAX_CONCURRENT_CAPTURES) return null;
    if (!options.afterSavedMiss && this.state.running > 0 && this.state.lastStartedAtMs + hedgeAfterMs > Date.now()) return null;
    this.state.running += 1;
    this.state.lastStartedAtMs = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.state.running -= 1;
      this.notify();
      if (this.state.running === 0 && sharedCaptures.get(this.key) === this) sharedCaptures.delete(this.key);
    };
  }

  async waitForChange(hedgeAfterMs: number, stopped: Promise<never>, options: { afterSavedMiss: boolean }) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waits: Promise<unknown>[] = [this.changed.promise, stopped];
    const hedgeInMs = this.state.lastStartedAtMs + hedgeAfterMs - Date.now();
    if (!options.afterSavedMiss && this.state.running < MAX_CONCURRENT_CAPTURES && hedgeInMs > 0) {
      waits.push(new Promise<void>(resolve => { timer = setTimeout(resolve, hedgeInMs); }));
    }
    try {
      await Promise.race(waits);
    } finally {
      clearTimeout(timer);
    }
  }

  async savedCopy() {
    while (!this.state.saved) await this.changed.promise;
  }

  markSaved() {
    this.state.saved = true;
    this.notify();
  }

  private notify() {
    const changed = this.changed;
    this.changed = latch();
    changed.resolve();
  }
}

const sharedCaptures = new Map<string, SharedArtifactCapture>();

function sharedCaptureFor(key: string) {
  let shared = sharedCaptures.get(key);
  if (!shared) {
    shared = new SharedArtifactCapture(key);
    sharedCaptures.set(key, shared);
  }
  return shared;
}

function stopWith(signal: AbortSignal) {
  let stop!: () => void;
  const promise = new Promise<never>((_resolve, reject) => {
    stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
  promise.catch(() => undefined);
  return { promise, dispose: () => signal.removeEventListener("abort", stop) };
}

export async function shareNativeProviderArtifactCapture<T>(input: ShareNativeProviderArtifactCaptureInput<T>): Promise<T> {
  const hedgeAfterMs = input.hedgeAfterMs ?? NATIVE_PROVIDER_ARTIFACT_CAPTURE_HEDGE_MS;
  const stopped = stopWith(input.signal);
  try {
    let afterSavedMiss = false;
    for (;;) {
      const shared = sharedCaptureFor(input.key);
      const release = shared.tryStart(hedgeAfterMs, { afterSavedMiss });
      if (release) return await captureOrReuse(input, shared, release, stopped.promise);
      if (afterSavedMiss || !shared.saved) await shared.waitForChange(hedgeAfterMs, stopped.promise, { afterSavedMiss });
      const reused = await input.reuse();
      if (reused) {
        shared.markSaved();
        return reused;
      }
      afterSavedMiss ||= shared.saved;
    }
  } finally {
    stopped.dispose();
  }
}

async function captureOrReuse<T>(
  input: ShareNativeProviderArtifactCaptureInput<T>,
  shared: SharedArtifactCapture,
  release: () => void,
  stopped: Promise<never>,
): Promise<T> {
  const superseded = new AbortController();
  const held: Promise<unknown>[] = [];
  const own = Promise.resolve().then(() => input.capture(AbortSignal.any([input.signal, superseded.signal]), work => held.push(work)));
  void own.then(() => undefined, () => undefined).then(() => Promise.allSettled(held)).then(release);
  try {
    const first = await Promise.race([own.then(value => ({ value })), shared.savedCopy().then(() => null), stopped]);
    if (first) {
      shared.markSaved();
      return first.value;
    }
    const reused = await input.reuse();
    if (!reused) return await own;
    superseded.abort(new Error("native_provider_artifacts_capture_superseded"));
    return reused;
  } catch (error) {
    if (input.signal.aborted) throw error;
    const reused = await input.reuse().catch(() => null);
    if (!reused) throw error;
    shared.markSaved();
    return reused;
  }
}

export class NativeProviderArtifactExportError extends Error {
  readonly code: "native_provider_artifacts_export_timeout" | "native_provider_artifacts_export_failed";
  constructor(cause: unknown) {
    const code = isPluginRpcTimeout(cause) ? "native_provider_artifacts_export_timeout" : "native_provider_artifacts_export_failed";
    super(`${code}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "NativeProviderArtifactExportError";
    this.code = code;
  }
}

// Copies the qualified launch files into a fresh export directory. The launch
// root sits under the sandbox account's home, outside the workspace remote dir,
// and sandbox providers confine bulk-export sources to that workspace. The copy
// refuses symlinks, so the confined export can only carry these regular files;
// Core still verifies every byte against the manifest digests after download.
const stageExportScript = [
  "set -eu",
  "umask 077",
  'parent=$1; target=$2; shift 2',
  'mkdir -p -- "$parent"',
  '{ [ -d "$parent" ] && [ ! -L "$parent" ]; } || exit 41',
  'mkdir -- "$target"',
  "for name in nodeCommand opencodeProxy opencodeExecutable; do",
  '  source=$1; shift',
  '  { [ -f "$source" ] && [ ! -L "$source" ]; } || exit 42',
  '  cp -P -- "$source" "$target/$name"',
  '  { [ -f "$target/$name" ] && [ ! -L "$target/$name" ]; } || exit 43',
  "done",
].join("\n");
const removeExportScript = 'set -eu\nrm -rf -- "$1"';

async function runExportCommand(runner: CommandManagedRuntimeRunner, script: string, args: string[]) {
  const result = await runner.execute({
    command: "sh",
    args: ["-c", script, "sh", ...args],
    bypassSession: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("native_provider_artifacts_remote_unavailable");
  }
}

export async function captureRemoteNativeProviderArtifacts<T>(
  input: {
    runner: CommandManagedRuntimeRunner;
    /** Workspace remote dir: the only root a sandbox bulk export may read. */
    remoteCwd: string;
    launch: OpenCodeLaunchArtifacts;
    manifest: NativeProviderArtifactSource["manifest"];
    signal: AbortSignal;
    context?: NativeExecutionContext;
    hold?: (work: Promise<unknown>) => void;
  },
  publish: (source: NativeProviderArtifactSource) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "paperclip-provider-launch-"));
  let ownedByOperation = false;
  try {
    const exportParent = posix.join(
      input.remoteCwd,
      ".paperclip-runtime",
      "paperclip-runner",
      "provider-artifact-export",
    );
    const exportRoot = posix.join(exportParent, randomUUID());
    const files = await Promise.all(
      names.map(
        async (name) => {
          const targetPath = join(
            root,
            input.manifest.payload.artifacts[name].path,
          );
          await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
          return {
            sourcePath: posix.join(exportRoot, name),
            targetPath,
            kind: "file" as const,
            mode: 0o500,
          };
        },
      ),
    );
    input.signal.throwIfAborted();
    const settled = input.context?.trackWorker();
    ownedByOperation = true;
    const operation = Promise.resolve()
      .then(async () => {
        input.signal.throwIfAborted();
        input.context?.assertOpen();
        try {
          await runExportCommand(input.runner, stageExportScript, [
            exportParent,
            exportRoot,
            ...names.map((name) => input.launch.paths[name]),
          ]);
          input.signal.throwIfAborted();
          input.context?.assertOpen();
          await input.runner.syncOut!([
            { operationId: `provider-artifacts-${randomUUID()}`, files },
          ]).catch((error: unknown) => {
            throw new NativeProviderArtifactExportError(error);
          });
        } finally {
          // The export copy is scratch under the excluded runtime dir. A failed
          // removal must not replace the transfer outcome; it is logged instead.
          await runExportCommand(input.runner, removeExportScript, [exportRoot]).catch((err) => {
            logger.warn({ err }, "native provider artifact export cleanup failed");
          });
        }
        for (let attempt = 1; ; attempt++) {
          input.signal.throwIfAborted();
          input.context?.assertOpen();
          try {
            return await publish({
              sourceRoot: root,
              manifest: input.manifest,
              launchRoot: input.launch.root,
              accountUid: input.launch.accountUid,
            });
          } catch (error) {
            if (!(error instanceof NativeProviderArtifactTransferTimeoutError) || attempt >= NATIVE_PROVIDER_ARTIFACT_PUBLISH_ATTEMPTS) throw error;
            logger.warn({ err: error, attempt }, "native provider artifact transfer timed out; retrying the transfer");
          }
        }
      })
      .finally(async () => {
        try {
          await removeNativeHarnessBackup(root);
        } catch (err) {
          logger.warn(
            { err },
            "native provider artifact capture cleanup failed",
          );
          throw err;
        } finally {
          settled?.();
        }
      });
    void operation.catch(() => undefined);
    input.hold?.(operation);
    let abort!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      abort = () => reject(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
    try {
      return await Promise.race([
        input.context ? input.context.wait(() => operation) : operation,
        stopped,
      ]);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  } finally {
    if (!ownedByOperation) await removeNativeHarnessBackup(root);
  }
}
