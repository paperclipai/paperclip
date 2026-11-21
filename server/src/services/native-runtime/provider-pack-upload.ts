import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRunTrace } from "./native-run-trace.js";
import { readProviderPackArchive, stageProviderPackArchive } from "./provider-pack-archive.js";
import type { ProviderPackIdentity } from "./remote-provider-pack-verification.js";
import { resolveProviderPackUploadSource } from "./retained-provider-pack-source.js";
import { providerPackExtractionProbe } from "./provider-pack-extraction.js";
import { providerPackLayersArgument } from "./provider-pack-layers.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Upload a pack and verify the installed bytes before exposing it to a provider. */
export async function uploadVerifiedProviderPack(input: {
  root: string;
  /** Identity of the controller pack at `root`. */
  sourceDigest: string;
  /** Identity selected for this execution; a retained session can pin an older release. */
  expectedDigest: string;
  manifest?: ProviderPackIdentity;
  signal?: AbortSignal;
  runner: CommandManagedRuntimeRunner;
  cwd: string;
  targetPath: string;
  reuseRoots: readonly string[];
  trace?: NativeRunTrace;
  verifyDirectory: (root: string) => void | Promise<void>;
  stageDirectory: (root: string) => Promise<void>;
  verifyUploaded: () => Promise<void>;
}): Promise<void> {
  if (input.sourceDigest !== input.expectedDigest && !input.manifest) {
    const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
    throw new Error(`runner_remote_provider_artifact_incompatible: selected provider pack ${short(input.expectedDigest)} is not the controller's pack ${short(input.sourceDigest)}; install the matching Paperclip package and Daytona image`);
  }
  const measure = <T>(name: string, fn: () => Promise<T>) => input.trace ? input.trace.measure(name, fn) : fn();
  input.signal?.throwIfAborted();
  if (input.manifest && input.manifest.digest !== input.expectedDigest) throw Error("runner_remote_provider_source_invalid");
  const source = input.manifest ? await measure("provider_pack.source", () => resolveProviderPackUploadSource({
    root: input.root, sourceDigest: input.sourceDigest, manifest: input.manifest!, signal: input.signal,
  })) : { root: input.root, archiveOnly: false };
  const verifyDirectory = () => measure("provider_pack.directory.verify", async () => input.verifyDirectory(source.root));
  // Archive installation reads the sealed archives, not the expanded tree.
  // Hash the directory only when it is actually the upload source. The
  // installed pack still passes full verification against the selected identity.
  const archive = await measure("provider_pack.archive.verify", () =>
    readProviderPackArchive(source.root, input.expectedDigest, input.signal));
  if (source.archiveOnly) {
    if (!archive) throw Error("runner_remote_provider_source_invalid");
    if ("kind" in archive && providerPackLayersArgument(archive, input.targetPath, input.reuseRoots) === null) {
      throw Error("runner_remote_provider_archive_transport_unavailable");
    }
    const capability = await measure("provider_pack.archive.probe", () => input.runner.execute({
      command: "sh", args: ["-c", `${providerPackExtractionProbe}${"kind" in archive ? " && node -e 'process.exit(Number(process.versions.node.split(\".\")[0])>=18?0:1)'" : ""}`],
      bypassSession: true, timeoutMs: 10_000,
    }));
    if (capability.exitCode !== 0 || capability.timedOut) throw Error("runner_remote_provider_archive_transport_unavailable");
  }
  if (!archive) await verifyDirectory();
  input.signal?.throwIfAborted();
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
    if (source.archiveOnly) throw Error("runner_remote_provider_archive_transport_unavailable");
    if (archive) await verifyDirectory();
    await input.stageDirectory(source.root);
  });
  await measure("provider_pack.verify_uploaded", input.verifyUploaded);
}
