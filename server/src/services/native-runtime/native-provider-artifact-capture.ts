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

const names = ["nodeCommand", "opencodeProxy", "opencodeExecutable"] as const;
export const NATIVE_PROVIDER_ARTIFACT_PUBLISH_ATTEMPTS = 3;
const sharedCaptures = new Map<string, Promise<unknown>>();

export async function shareNativeProviderArtifactCapture<T>(input: {
  key: string;
  signal: AbortSignal;
  reuse: () => Promise<T | null>;
  capture: () => Promise<T>;
}): Promise<T> {
  const inFlight = sharedCaptures.get(input.key);
  if (inFlight) {
    let stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = () => reject(input.signal.reason);
      input.signal.addEventListener("abort", stop, { once: true });
      if (input.signal.aborted) stop();
    });
    try {
      await Promise.race([inFlight.catch(() => undefined), stopped]);
    } finally {
      input.signal.removeEventListener("abort", stop);
    }
    const reused = await input.reuse();
    if (reused) return reused;
  }
  const own = input.capture();
  sharedCaptures.set(input.key, own);
  try {
    return await own;
  } finally {
    if (sharedCaptures.get(input.key) === own) sharedCaptures.delete(input.key);
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
          ]);
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
