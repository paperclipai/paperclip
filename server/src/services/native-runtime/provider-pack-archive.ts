import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { NativeRunTrace } from "./native-run-trace.js";
import { readProviderPackLayers, stageProviderPackLayers } from "./provider-pack-layers.js";
import { providerPackExtractionProbe } from "./provider-pack-extraction.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function readProviderPackArchive(root: string, expectedDigest: string) {
  let receipt: { schema?: string; encoding?: string; providerPackDigest?: string; sha256?: string; bytes?: number };
  try {
    receipt = JSON.parse(await readFile(`${root}.archive.json`, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("runner_remote_provider_archive_invalid", { cause: error });
  }
  if (receipt.schema === "paperclip-runner/provider-pack-archive/v2") {
    return readProviderPackLayers(root, expectedDigest, receipt);
  }
  if (receipt.schema !== "paperclip-runner/provider-pack-archive/v1"
    || receipt.encoding !== "tar+zstd"
    || receipt.providerPackDigest !== expectedDigest
    || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? "")
    || !Number.isSafeInteger(receipt.bytes) || receipt.bytes! <= 0) {
    throw new Error("runner_remote_provider_archive_invalid");
  }
  const sourcePath = `${root}.tar.zst`;
  const file = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== receipt.bytes) throw new Error("runner_remote_provider_archive_invalid");
    const hash = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== receipt.sha256) throw new Error("runner_remote_provider_archive_invalid");
  } finally {
    await file.close();
  }
  return { sourcePath, sha256: receipt.sha256!, bytes: receipt.bytes! };
}

export async function stageProviderPackArchive(input: {
  archive: NonNullable<Awaited<ReturnType<typeof readProviderPackArchive>>>;
  runner: CommandManagedRuntimeRunner;
  targetPath: string;
  trace?: NativeRunTrace;
  reuseRoots?: readonly string[];
}): Promise<boolean> {
  if ("kind" in input.archive) return stageProviderPackLayers({ ...input, archive: input.archive, reuseRoots: input.reuseRoots ?? [] });
  const archive = input.archive;
  if (!input.runner.syncIn) throw new Error("runner_remote_provider_archive_transport_unavailable");
  const archivePath = `${input.targetPath}.upload-${randomUUID()}.tar.zst`;
  const measure = <T>(name: string, fn: () => Promise<T>) => input.trace ? input.trace.measure(name, fn) : fn();
  const capability = await measure("provider_pack.archive.probe", () => input.runner.execute({
    command: "sh", args: ["-c", providerPackExtractionProbe],
    bypassSession: true, timeoutMs: 10_000,
  }));
  if (capability.exitCode !== 0 || capability.timedOut) return false;
  try {
    await measure("provider_pack.archive.transfer", () => input.runner.syncIn!([{
      operationId: `runner-provider-archive-${randomUUID()}`,
      files: [{ kind: "file", sourcePath: archive.sourcePath, targetPath: archivePath, mode: 0o600 }],
    }]));
    const result = await measure("provider_pack.archive.extract", () => input.runner.execute({
      command: "sh",
      args: ["-c", [
        "set -eu; umask 077;",
        `test ! -L ${quote(archivePath)}; test -f ${quote(archivePath)};`,
        `test "$(sha256sum -- ${quote(archivePath)} | cut -d ' ' -f 1)" = ${quote(archive.sha256)};`,
        `test ! -L ${quote(input.targetPath)}; mkdir -p ${quote(input.targetPath)};`,
        `tar --zstd -xf ${quote(archivePath)} --no-same-owner --same-permissions --delay-directory-restore -C ${quote(input.targetPath)};`,
        `chmod 700 ${quote(input.targetPath)};`,
      ].join(" ")],
      bypassSession: true,
      timeoutMs: 120_000,
    }));
    if (result.exitCode !== 0 || result.timedOut) throw new Error("runner_remote_provider_archive_extract_failed");
    return true;
  } finally {
    await input.runner.execute({ command: "sh", args: ["-c", `rm -f -- ${quote(archivePath)}`],
      bypassSession: true, timeoutMs: 10_000 }).catch(() => undefined);
  }
}
