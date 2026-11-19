import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { ACPX_RELEASE_PROFILE_DIGESTS, type NativeAcpxAgent } from "../../vendor/paperclip-runner/index.js";
import { resolvePaperclipRunnerBinaryAsync } from "./native-codex-runner.js";

export { RUNNER_ACPX_PROFILE_INCOMPATIBLE } from "../continuation-cause.js";
export const RUNNER_COMPATIBILITY_RECHECK_MS = 30_000;

const execFileAsync = promisify(execFile);
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

type MetadataProbe = { binary: string; stamp: string; profiles: Promise<Record<string, unknown> | null>; recheckAt: number };
let lastProbe: MetadataProbe | undefined;

async function readProfiles(binary: string) {
  try {
    const { stdout } = await execFileAsync(binary, ["--build-metadata"], { timeout: 2_000, maxBuffer: 64 * 1024 });
    const metadata = object(JSON.parse(stdout));
    if (metadata.schema !== "paperclip-runner/runnerd-build-metadata/v1") return null;
    const profiles = metadata.acpxReleaseProfileDigests;
    return profiles ? object(profiles) : null;
  } catch {
    return null;
  }
}

export async function localAcpxRunnerCompatibility(agent: NativeAcpxAgent, binary?: string) {
  try {
    binary ??= await resolvePaperclipRunnerBinaryAsync();
    const info = await stat(binary, { bigint: true });
    const stamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    if (lastProbe?.binary !== binary || lastProbe.stamp !== stamp || lastProbe.recheckAt <= Date.now()) {
      const probe: MetadataProbe = { binary, stamp, profiles: readProfiles(binary), recheckAt: Infinity };
      lastProbe = probe;
      void probe.profiles.then(profiles => {
        if (!profiles) probe.recheckAt = Date.now() + 5_000;
      });
    }
    const profiles = await lastProbe.profiles;
    if (!profiles) return "unknown";
    return profiles[agent] === ACPX_RELEASE_PROFILE_DIGESTS[agent] ? "compatible" : "incompatible";
  } catch {
    return "unknown";
  }
}

export function savedRunnerCompatibilityAgent(result: unknown): NativeAcpxAgent | null {
  const agent = object(object(result).runnerCompatibility).acpxAgent;
  return typeof agent === "string" && Object.hasOwn(ACPX_RELEASE_PROFILE_DIGESTS, agent)
    ? agent as NativeAcpxAgent : null;
}

export function isLegacyRunnerAcpxProfileRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.startsWith("PRP command run.prepare failed:")) return false;
  const command = object(object(error).runnerCommandResult);
  const result = object(command.result);
  return command.commandType === "run.prepare" && result.code === "command_execution_failed"
    && result.message === "ACPX provider descriptor does not match a qualified immutable profile";
}
