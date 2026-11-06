import { logger } from "../../middleware/logger.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeProviderArtifactSource } from "./native-provider-artifacts.js";
import type { OpenCodeLaunchArtifacts } from "./remote-opencode-artifacts.js";
import type { NativeExecutionContext } from "./native-execution-context.js";
import { removeNativeHarnessBackup } from "./native-harness-backup-cleanup.js";

export async function captureRemoteNativeProviderArtifacts<T>(
  input: {
    runner: CommandManagedRuntimeRunner;
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
    const files = await Promise.all(
      (["nodeCommand", "opencodeProxy", "opencodeExecutable"] as const).map(
        async (name) => {
          const targetPath = join(
            root,
            input.manifest.payload.artifacts[name].path,
          );
          await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
          return {
            sourcePath: input.launch.paths[name],
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
        await input.runner.syncOut!([
          { operationId: `provider-artifacts-${randomUUID()}`, files },
        ]);
        input.signal.throwIfAborted();
        input.context?.assertOpen();
        return publish({
          sourceRoot: root,
          manifest: input.manifest,
          launchRoot: input.launch.root,
          accountUid: input.launch.accountUid,
        });
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
