import { existsSync } from "node:fs";
import { posix, resolve } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRuntimeContextSnapshot } from "../../vendor/paperclip-runner/index.js";
import type { NativeRunTrace } from "./native-run-trace.js";

type StageAsset = {
  sourcePath: string;
  targetPath: string;
  mode: number;
};

type LaunchAssetsInput = {
  root: string;
  transport: "ssh" | "sandbox";
  runner: CommandManagedRuntimeRunner;
  persistenceDirectories: readonly {
    name: string;
    location: "runner" | "filesystem";
    targetPath: string | null;
  }[];
  runtimeContext: {
    source: NativeRuntimeContextSnapshot;
    target: NativeRuntimeContextSnapshot;
    filesystemRoot: string;
  } | null;
  caBundleMapping: { sourcePath: string; targetPath: string } | null;
  stageFile: (input: StageAsset) => Promise<void>;
  stageDirectory: (input: StageAsset) => Promise<void>;
  trace?: NativeRunTrace;
};

export async function stageRemoteLaunchAssets(input: LaunchAssetsInput): Promise<void> {
  const measure = async (name: string, operation: () => Promise<void>) =>
    input.trace ? input.trace.measure(name, operation) : operation();
  const materializeLaunchState = () => measure("harness_state.launch_material", async () => {
    for (const directory of input.persistenceDirectories) {
      if (directory.location !== "filesystem") continue;
      const targetPath = directory.targetPath;
      if (!targetPath) throw new Error("runner_harness_state_mismatch: bootstrap_target_unavailable");
      const escapedTarget = targetPath.replaceAll("'", "'\\''");
      const created = await input.runner.execute({
        command: "sh",
        args: ["-c", `umask 077; install -d -m 0700 '${escapedTarget}'`],
        bypassSession: true,
        timeoutMs: 10_000,
      });
      if (created.exitCode !== 0 || created.timedOut) {
        throw new Error("runner_remote_directory_staging_failed");
      }
      if (directory.name !== "codex-home") continue;
      const localDirectory = resolve(input.root, directory.name);
      for (const name of ["auth.json", "config.toml"] as const) {
        const sourcePath = resolve(localDirectory, name);
        if (!existsSync(sourcePath)) continue;
        await input.stageFile({ sourcePath, targetPath: posix.join(targetPath, name), mode: 0o600 });
      }
    }
  });
  const stageRuntimeContext = async () => {
    const context = input.runtimeContext;
    if (!context) return;
    await measure("stage.asset.runtime_context", async () => {
      await input.stageDirectory({
        sourcePath: context.source.instructions.bundle.rootPath,
        targetPath: context.target.instructions.bundle.rootPath,
        mode: 0o555,
      });
      for (let index = 0; index < context.source.skills.length; index += 1) {
        await input.stageDirectory({
          sourcePath: context.source.skills[index]!.bundle.rootPath,
          targetPath: context.target.skills[index]!.bundle.rootPath,
          mode: 0o555,
        });
      }
      await input.stageFile({
        sourcePath: resolve(input.root, "runtime-context.json"),
        targetPath: posix.join(context.filesystemRoot, "runtime-context.json"),
        mode: 0o600,
      });
    });
  };
  if (input.transport === "sandbox" && input.runner.allowConcurrentSyncOperations === true) {
    const outcomes = await Promise.allSettled([materializeLaunchState(), stageRuntimeContext()]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
  } else {
    await materializeLaunchState();
    await stageRuntimeContext();
  }
  if (input.caBundleMapping) {
    const mapping = input.caBundleMapping;
    await measure("stage.asset.ca_bundle", () => input.stageFile({ ...mapping, mode: 0o600 }));
  }
}
