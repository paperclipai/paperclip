import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRunTrace } from "./native-run-trace.js";
import { readProviderPackArchive, stageProviderPackArchive } from "./provider-pack-archive.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Upload a pack and verify the installed bytes before exposing it to a provider. */
export async function uploadVerifiedProviderPack(input: {
  root: string;
  expectedDigest: string;
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  targetPath: string;
  reuseRoots: readonly string[];
  trace?: NativeRunTrace;
  verifyDirectory: () => void;
  stageDirectory: () => Promise<void>;
  verifyUploaded: () => Promise<void>;
}): Promise<void> {
  const measure = <T>(name: string, fn: () => Promise<T>) => input.trace ? input.trace.measure(name, fn) : fn();
  const verifyDirectory = () => measure("provider_pack.directory.verify", async () => input.verifyDirectory());
  // Archive installation reads the sealed archives, not the expanded tree.
  // Hash the directory only when it is actually the upload source. The
  // installed pack still passes full verification against the selected identity.
  const archive = await measure("provider_pack.archive.verify", () =>
    readProviderPackArchive(input.root, input.expectedDigest));
  if (!archive) await verifyDirectory();
  const cleared = await measure("provider_pack.clear_stale", () => input.runner.execute({
    command: "sh", args: ["-c", `rm -rf ${quote(input.targetPath)}`],
    cwd: input.cwd, bypassSession: true, timeoutMs: 10_000,
  }));
  if (cleared.exitCode !== 0 || cleared.timedOut) {
    throw new Error("runner_remote_provider_artifact_incompatible: stale provider pack could not be replaced");
  }
  await measure("provider_pack.upload", async () => {
    if (archive && await stageProviderPackArchive({
      archive, runner: input.runner, targetPath: input.targetPath,
      reuseRoots: input.reuseRoots, trace: input.trace,
    })) return;
    if (archive) await verifyDirectory();
    await input.stageDirectory();
  });
  await measure("provider_pack.verify_uploaded", input.verifyUploaded);
}
