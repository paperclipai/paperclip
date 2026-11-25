import { redactSensitiveText } from "../../redaction.js";
import { nativeRunFailureCheck, type NativeRunTrace } from "./native-run-trace.js";
import { ANTIGRAVITY_DISTRIBUTION_PINS, COPILOT_CLOSURE_SHA256, type NativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

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
 * release admits per platform. It is read from the Runner's generated pins, so
 * re-pinning the closure in antigravity-distributions.json can never leave a
 * stale server copy; a test keeps it equal to the `verified-closure` platforms.
 */
export const ANTIGRAVITY_PATCHED_CLOSURE_SHA256: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ANTIGRAVITY_DISTRIBUTION_PINS).map(([target, pin]) => [target, pin.closureSha256])),
);

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

type ProviderPackProfile = { agentServerVersion: string; commandDigest: string };

/** The provider identities one server release admits in a remote pack. */
export type RemoteProviderPackRelease = {
  profiles: {
    cursor: ProviderPackProfile;
    copilot: ProviderPackProfile;
    kimi: ProviderPackProfile & { qualificationStatus?: string };
    antigravity: ProviderPackProfile;
  };
  cursorClosures: Readonly<Record<string, { closureSha256: string }>>;
  kimiLinuxX64Closure: string;
  antigravityReleasePending: boolean;
  antigravityPatchedClosures?: Readonly<Record<string, string>>;
};

/** Copilot's pinned closure per platform: the Runner's canonical pins. */
export const COPILOT_PROVIDER_PACK_CLOSURES: Readonly<Record<string, string>> = COPILOT_CLOSURE_SHA256;

/**
 * The complete expectation for one provider entry of a remote pack: which
 * inventory may list it, its qualification, asset path, digests, and the
 * release's profile and closure for the pack target. Returns null when the
 * entry is admitted, else the refusal reason.
 */
export function remoteProviderPackEntryRefusal(input: {
  provider: string;
  inventory: "providers" | "candidateProviders";
  allowedProviders: readonly string[];
  target: { platform: string; architecture: string };
  entry: unknown;
  /** Whether the provider is listed in each inventory of the same pack. */
  listed: { providers: boolean; candidateProviders: boolean };
  release: RemoteProviderPackRelease;
}): string | null {
  const { provider, inventory, target, release } = input;
  const entry = input.entry as Record<string, unknown> | null | undefined;
  const kimiPending = release.profiles.kimi.qualificationStatus === "pending";
  const qualified = ["pi", "cursor"].includes(provider) || inventory === "providers" && (provider === "copilot" || provider === "kimi" && !kimiPending
    || provider === "antigravity" && !release.antigravityReleasePending);
  if (!input.allowedProviders.includes(provider) || !entry || typeof entry !== "object"
    || Object.keys(entry).some(key => !["version", "profileDigest", "closureDigest", "qualification", "path", "sha256"].includes(key))
    || entry.qualification !== (qualified ? "qualified" : "pending") || entry.path !== `provider-assets/${provider}/${target.platform}-${target.architecture}`
    || typeof entry.version !== "string" || !entry.version || entry.version.length > 120
    || !/^sha256:[a-f0-9]{64}$/.test(String(entry.profileDigest))
    || !/^sha256:[a-f0-9]{64}$/.test(String(entry.closureDigest))
    || !/^sha256:[a-f0-9]{64}$/.test(String(entry.sha256))) {
    return "invalid candidate identity";
  }
  const identity = entry as ProviderPackEntry;
  const platform = `${target.platform}-${target.architecture}`;
  const matches = (profile: ProviderPackProfile, closure: string | undefined) => closure !== undefined
    && identity.version === profile.agentServerVersion && identity.profileDigest === profile.commandDigest && identity.closureDigest === `sha256:${closure}`;
  if (provider === "cursor") {
    const closure = Object.hasOwn(release.cursorClosures, platform) ? release.cursorClosures[platform]!.closureSha256 : undefined;
    if (!matches(release.profiles.cursor, closure)) return "Cursor profile or closure does not match this release";
  }
  if (provider === "copilot") {
    const closure = Object.hasOwn(COPILOT_PROVIDER_PACK_CLOSURES, platform) ? COPILOT_PROVIDER_PACK_CLOSURES[platform] : undefined;
    if ((input.listed.providers && input.listed.candidateProviders) || !matches(release.profiles.copilot, closure)) {
      return "Copilot profile or closure does not match this release";
    }
  }
  if (provider === "kimi") {
    if (inventory !== (kimiPending ? "candidateProviders" : "providers") || input.listed[kimiPending ? "providers" : "candidateProviders"]
      || platform !== "linux-x64" || !matches(release.profiles.kimi, release.kimiLinuxX64Closure)) {
      return "Kimi profile or closure does not match this release";
    }
  }
  if (provider === "antigravity") {
    return antigravityProviderPackEntryRefusal({ inventory, target, entry: identity,
      inBoth: input.listed.providers && input.listed.candidateProviders,
      releasePending: release.antigravityReleasePending, profile: release.profiles.antigravity,
      patchedClosures: release.antigravityPatchedClosures });
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
