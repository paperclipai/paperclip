import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { runnerBinaryTarget } from "../../vendor/paperclip-runner/index.js";
import { binaryTargetFromHeader, cachedFileSha256 } from "./off-loop-file-work.js";

export const DEFAULT_REMOTE_PROVIDER_PACK = "/opt/paperclip-runner/provider-pack";
export const DEFAULT_REMOTE_RUNTIMES = "/opt/paperclip-runner/remote-runtimes";

const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);

async function boundedJson(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
    throw new Error("runner_remote_artifact_incompatible: invalid macOS runtime metadata");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

export async function resolveRemoteOpenCodeArtifacts(input: {
  runner: CommandManagedRuntimeRunner;
  remoteCwd: string;
  configuredProviderPack?: string | null;
  configuredRunner?: string | null;
  runtimeRoot?: string;
}): Promise<{ runnerBinary: string; providerPack: string } | null> {
  const configured = input.configuredProviderPack?.trim();
  if ((configured && configured !== DEFAULT_REMOTE_PROVIDER_PACK) || input.configuredRunner?.trim()) return null;
  const probe = await input.runner.execute({ command: "sh", args: ["-c", "uname -s; uname -m"],
    cwd: input.remoteCwd, bypassSession: true, timeoutMs: 10_000 });
  if (probe.exitCode !== 0 || probe.timedOut) {
    throw new Error("runner_remote_artifact_platform_mismatch: could not identify the SSH host platform");
  }
  const [platform, architecture] = probe.stdout.trim().split(/\r?\n/);
  if (platform !== "Darwin") return null;
  if (architecture !== "arm64") {
    throw new Error("runner_remote_artifact_unavailable: automatic macOS OpenCode SSH runtime requires Apple Silicon");
  }
  const runtimeRoot = input.runtimeRoot?.trim() || DEFAULT_REMOTE_RUNTIMES;
  if (!isAbsolute(runtimeRoot)) throw new Error("PAPERCLIP_RUNNER_REMOTE_RUNTIMES_PATH must be an absolute path");
  const root = resolve(runtimeRoot, "darwin-arm64");
  try {
    if (await realpath(root) !== root) throw new Error("linked runtime root");
    const metadata = await boundedJson(join(root, "runtime.json"));
    const providerPack = join(root, "provider-pack");
    const pack = await boundedJson(join(providerPack, "provider-pack.json"));
    const runnerBinary = join(root, "bin", "paperclip-runnerd");
    const runner = await lstat(runnerBinary);
    const packDigest = `sha256:${createHash("sha256").update(canonical(pack.payload)).digest("hex")}`;
    if (metadata.schema !== "paperclip.runner.remote-runtime.v1" || metadata.target !== "darwin-arm64"
      || !/^[a-f0-9]{40}$/.test(metadata.sourceRevision ?? "")
      || pack.schema !== "paperclip-runner/remote-provider-pack/v1"
      || pack.payload?.runnerSourceRevision !== metadata.sourceRevision
      || pack.payload?.target?.platform !== "darwin" || pack.payload?.target?.architecture !== "arm64"
      || metadata.providerPackDigest !== pack.digest || pack.digest !== packDigest
      || !/^sha256:[a-f0-9]{64}$/.test(metadata.runnerSha256 ?? "")
      || !runner.isFile() || runner.isSymbolicLink() || (runner.mode & 0o111) === 0
      || await binaryTargetFromHeader(runnerBinary, runnerBinaryTarget) !== "darwin-arm64"
      || await cachedFileSha256(runnerBinary) !== metadata.runnerSha256) {
      throw new Error("runtime source, target or digest mismatch");
    }
    return { runnerBinary, providerPack };
  } catch (cause) {
    throw new Error("runner_remote_artifact_unavailable: install the Core image with its verified darwin-arm64 OpenCode runtime", { cause });
  }
}
