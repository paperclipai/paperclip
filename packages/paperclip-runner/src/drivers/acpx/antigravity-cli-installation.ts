import { lstatSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { ANTIGRAVITY_CLI_DISTRIBUTION, type AntigravityCliTarget } from "./antigravity-cli-pins.js";
import { verifyNativeAcpxInstallation, type VerifiedAcpxInstallation } from "./installation-integrity.js";
import type { NativeAcpxDistributionInput } from "./native-distribution-integrity.js";
import { realRuntimeCachePath } from "./runtime-cache-path.js";

/**
 * Google Antigravity CLI (`agy acp`) route: distribution and launch identity only.
 * Route selection, endpoint, modes, `--gemini-dir` and every other flag are the
 * driver's policy and arrive here as `arguments`.
 */
export const ANTIGRAVITY_CLI_CLOSURE_MANIFEST = ".paperclip-antigravity-cli-closure.json";
const SETUP_COMMAND = "paperclipai runtime setup antigravity-cli";

export type AntigravityCliRuntimeErrorCode = "ANTIGRAVITY_CLI_UNSUPPORTED_PLATFORM" | "ANTIGRAVITY_CLI_RUNTIME_MISSING";

export class AntigravityCliRuntimeError extends Error {
  readonly retryable = false;
  constructor(readonly code: AntigravityCliRuntimeErrorCode, message: string) {
    super(message);
    this.name = "AntigravityCliRuntimeError";
  }
}

export interface AntigravityCliLaunchOptions {
  /** Driver-owned arguments, appended after the pinned leading arguments (`acp`). */
  arguments?: readonly string[];
  platform?: NodeJS.Platform;
  architecture?: string;
  /** Owner of `~/.paperclip/runtimes`; independent of the provider's private HOME. */
  home?: string;
}

export interface AntigravityCliLaunch {
  readonly version: string;
  readonly build: string;
  readonly target: AntigravityCliTarget;
  /** `sha256:` of the pinned executable closure. */
  readonly commandDigest: string;
  /** Exactly what the executable receives: pinned leading arguments, then the driver's. */
  readonly arguments: readonly string[];
  /** Pinned launch environment (self-update off). */
  readonly environment: Readonly<Record<string, string>>;
  /** Merge the pinned environment over a driver-built one; the pins always win. */
  environmentFor(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /**
   * Sealed-store launch: `openCommand()` admits the verified copy, and each
   * spawn re-hashes the executable descriptor it runs. Spawn takes no arguments.
   */
  readonly installation: VerifiedAcpxInstallation;
}

function pinnedTarget(platform: string, architecture: string): AntigravityCliTarget {
  const target = `${platform}-${architecture}`;
  if (!Object.hasOwn(ANTIGRAVITY_CLI_DISTRIBUTION.platforms, target)) {
    throw new AntigravityCliRuntimeError("ANTIGRAVITY_CLI_UNSUPPORTED_PLATFORM",
      `The Antigravity CLI has no pinned build for ${target}. Supported hosts: ${Object.keys(ANTIGRAVITY_CLI_DISTRIBUTION.platforms).join(", ")}.`);
  }
  return target as AntigravityCliTarget;
}

/** `~/.paperclip/runtimes/antigravity-cli/<target>/<closure>`, beside the registry-server runtime. */
export function antigravityCliRuntimeCachePath(closure: string, platform: string, architecture: string, home = userInfo().homedir): string {
  pinnedTarget(platform, architecture);
  if (!/^[a-f0-9]{64}$/.test(closure) || !isAbsolute(home) || home.includes("\0")) throw new Error("Invalid Antigravity CLI runtime cache identity");
  return realRuntimeCachePath(home, "antigravity-cli", `${platform}-${architecture}`, closure, "Antigravity CLI runtime cache must contain real directories");
}

/** Resolve the pinned, installed CLI for this host and admit it through the sealed launch store. */
export async function resolveAntigravityCliLaunch(options: AntigravityCliLaunchOptions = {}): Promise<AntigravityCliLaunch> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const target = pinnedTarget(platform, architecture);
  const extra = options.arguments ?? [];
  if (!Array.isArray(extra) || extra.length > 64 || extra.some(arg => typeof arg !== "string" || arg.length > 16_384 || arg.includes("\0"))) {
    throw new Error("Antigravity CLI launch arguments are invalid");
  }
  const pin = ANTIGRAVITY_CLI_DISTRIBUTION.platforms[target];
  const distributionRoot = antigravityCliRuntimeCachePath(pin.closureSha256, platform, architecture, options.home);
  try { lstatSync(distributionRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new AntigravityCliRuntimeError("ANTIGRAVITY_CLI_RUNTIME_MISSING",
      `The Antigravity CLI ${ANTIGRAVITY_CLI_DISTRIBUTION.version} is not installed on this host. Run ${SETUP_COMMAND} as the user that runs Paperclip.`);
  }
  const fixedArguments = Object.freeze([...ANTIGRAVITY_CLI_DISTRIBUTION.args, ...extra]);
  const spec: NativeAcpxDistributionInput = {
    distributionRoot, manifestPath: join(distributionRoot, ANTIGRAVITY_CLI_CLOSURE_MANIFEST), expectedClosureSha256: pin.closureSha256,
    executable: pin.executable, fixedArguments, storeFamily: "antigravity-cli",
  };
  const installation = await verifyNativeAcpxInstallation(spec);
  const environment: Readonly<Record<string, string>> = Object.freeze({ ...ANTIGRAVITY_CLI_DISTRIBUTION.environment });
  return Object.freeze({
    version: ANTIGRAVITY_CLI_DISTRIBUTION.version, build: ANTIGRAVITY_CLI_DISTRIBUTION.build, target,
    commandDigest: installation.commandDigest, arguments: fixedArguments, environment,
    environmentFor: (base: NodeJS.ProcessEnv) => ({ ...base, ...environment }),
    installation,
  });
}
