import { redactSensitiveText } from "../../redaction.js";
import { nativeRunFailureCheck, type NativeRunTrace } from "./native-run-trace.js";
import type { NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Qualified ACPX releases carry their Linux image manifest and daemon. */
export function shouldUseBundledAcpxImageAssets(input: {
  requiresRemoteProviderPack: boolean;
  configuredProviderPackRoot: string | null;
  provider: NativeExecutionInput["provider"];
}): boolean {
  return input.requiresRemoteProviderPack && !input.configuredProviderPackRoot &&
    input.provider.kind === "acpx" &&
    ["cursor", "copilot", "kimi", "antigravity"].includes(input.provider.agent);
}

/**
 * The patched Antigravity closure (never the vendor closure) this server
 * release admits per platform: exactly the `verified-closure` platforms'
 * `closureSha256` in packages/paperclip-runner/antigravity-distributions.json,
 * which a test keeps equal. Linux appears here when the Linux runtime is
 * pinned; until then no Antigravity image pack verifies.
 */
export const ANTIGRAVITY_PATCHED_CLOSURE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "darwin-arm64": "044792d793e203bc8b4524a418f1816c4d34db67bb41fa4bae5947a050c49b4a",
});

export type ProviderPackEntry = { version: string; profileDigest: string; closureDigest: string };

/**
 * The image pack contract for Antigravity. While the profile is pending the
 * entry lives only under `candidateProviders`; after the flip only under
 * `providers`. It targets Linux x64 and pins this release's profile and the
 * patched closure. Returns null when admitted, else a refusal reason.
 */
export function antigravityProviderPackEntryRefusal(input: {
  inventory: "providers" | "candidateProviders";
  target: { platform: string; architecture: string };
  inBoth: boolean;
  entry: ProviderPackEntry;
  releasePending: boolean;
  profile: { agentServerVersion: string; commandDigest: string };
  patchedClosures?: Readonly<Record<string, string>>;
}): string | null {
  const expectedInventory = input.releasePending ? "candidateProviders" : "providers";
  if (input.inventory !== expectedInventory || input.inBoth) return "Antigravity is listed under the wrong pack inventory";
  if (input.target.platform !== "linux" || input.target.architecture !== "x64") return "Antigravity pack target must be linux-x64";
  const closure = (input.patchedClosures ?? ANTIGRAVITY_PATCHED_CLOSURE_SHA256)["linux-x64"];
  if (!closure || input.entry.closureDigest !== `sha256:${closure}`) return "Antigravity closure is not this release's patched closure";
  if (input.entry.version !== input.profile.agentServerVersion || input.entry.profileDigest !== input.profile.commandDigest) {
    return "Antigravity profile does not match this release";
  }
  return null;
}

/** A run may adopt a same-content pack from another build only when no saved or operator-selected identity binds it. */
export function providerPackProvenanceReuseAllowed(input: {
  retainProviderPack: boolean;
  explicitProviderPackSelection: boolean;
  authoritySelectable: boolean;
}): boolean {
  return !input.retainProviderPack && !input.explicitProviderPackSelection && input.authoritySelectable;
}

type VerificationCommandResult = {
  exitCode: number | null;
  timedOut: boolean;
  signal?: string | null;
  stdout: string;
  stderr: string;
};

/** Retry only these read-only probes, never provider work or artifact mutations.
 * Each transport call enforces its own 30s timeout; two attempts is the hard cap.
 * A completed, failing verifier is incompatible. An interrupted probe proves no
 * incompatibility. Exhaustion holds the original run: reattachment does not
 * spend a new provider attempt, so scheduling another attach could loop.
 */
export async function runRemoteProviderVerification(
  execute: () => Promise<VerificationCommandResult>,
  label: string,
): Promise<VerificationCommandResult> {
  let diagnostic = "command unavailable";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) await new Promise<void>(resolve => setTimeout(resolve, 1_000));
    let result: VerificationCommandResult;
    try {
      result = await execute();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      diagnostic = redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(-1_024);
      continue;
    }
    diagnostic = `exitCode=${result.exitCode}; timedOut=${result.timedOut}; signal=${result.signal ?? "none"}; ${redactSensitiveText([result.stderr, result.stdout].filter(Boolean).join("\n")).trim().slice(-1_024)}`;
    if (result.timedOut || result.exitCode === null || result.signal) continue;
    if (result.exitCode !== 0) {
      throw new Error(`runner_remote_provider_artifact_incompatible: ${label} failed (${diagnostic})`);
    }
    return result;
  }
  throw new Error(`runner_remote_provider_verification_unavailable: ${label} unavailable after 2 verification attempts (${diagnostic.slice(-1_536)})`);
}

/** Reuse only a pack that passes the same full verification as a new upload. */
export async function prepareVerifiedRemoteProviderPack(input: {
  trace?: NativeRunTrace;
  verifyStaged: () => Promise<void>;
  usePreinstalled: (onRejected: (check: string) => void) => Promise<boolean>;
  stageAndVerify: () => Promise<void>;
}): Promise<"staged" | "preinstalled" | "uploaded"> {
  const scope = input.trace?.start("provider_pack.select");
  let failed = false;
  let preinstalledCheck = "no_preinstalled_pack";
  const select = async () => {
    try {
      await input.verifyStaged();
      return "staged" as const;
    } catch {}
    let rejected = false;
    if (await input.usePreinstalled(check => { if (!rejected) preinstalledCheck = check; rejected = true; })) return "preinstalled" as const;
    await input.stageAndVerify();
    return "uploaded" as const;
  };
  try {
    const source = scope ? await input.trace!.run(scope, select) : await select();
    if (scope) input.trace!.annotate(scope, { stateSource: source,
      reason: source === "uploaded" ? "cached_packs_unverified" : "verified_pack_reused",
      ...(source === "uploaded" ? { check: preinstalledCheck } : {}) });
    return source;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (scope) await input.trace!.end(scope, { outcome: failed ? "failed" : "ok" });
  }
}

export async function useVerifiedPreinstalledRemoteProviderPack(input: {
  candidates: readonly string[];
  verifyAndLink: (root: string) => Promise<void>;
  onRejected?: (check: string) => void;
}): Promise<boolean> {
  for (const candidate of input.candidates) {
    try {
      await input.verifyAndLink(candidate);
      return true;
    } catch (error) {
      input.onRejected?.(nativeRunFailureCheck(error) ?? "verification_failed");
    }
  }
  return false;
}
