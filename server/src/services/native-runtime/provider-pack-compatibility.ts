import { createHash } from "node:crypto";

export function canonicalProviderPackJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalProviderPackJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalProviderPackJson(entry)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export type ProviderPackIdentity = {
  schema: string;
  digest: string;
  payload: {
    compatibility?: { opencode: number; acpx: number };
    contractDigest?: string;
    acpxProfileDigests?: Record<string, string>;
    providers?: Record<string, unknown>;
    candidateProviders?: Record<string, unknown>;
    pins: { opencode: string; [key: string]: string | null };
    target: { platform: string; architecture: string };
    runnerSourceRevision: string;
    runnerInputsDigest?: string;
    artifacts: { nodeCommand: { path: string; sha256: string }; opencodeCommand: { path: string; sha256: string }; [key: string]: { path: string; sha256: string } };
  };
};

export function providerPackIncompatible(check: string, detail: string): Error & { failureCheck: string } {
  return Object.assign(new Error(`runner_remote_provider_artifact_incompatible: ${detail}`), { failureCheck: check });
}

export type ProviderPackInstallation = { root: string; manifest: unknown; immutable: boolean };
export type PackProvider = { kind: "opencode" } | { kind: "acpx"; agent: string };
export type AdmittedProviderPackReceipt = {
  providerPackDigest: string;
  opencodeProxySha256: string;
  sourceRevision: string;
};

const KNOWN_NATIVE_ASSET_PROVIDERS = ["cursor", "copilot", "pi", "kimi", "antigravity"] as const;
const BUILTIN_NON_ASSET_ACPX_PROVIDERS = ["claude", "codex", "grok"] as const;
const SAFE_PROVIDER_ASSET_NAME = /^[a-z0-9-]+$/;

/** Narrows a native execution provider to a PackProvider when applicable. */
export function toPackProvider(
  provider: { kind: string; agent?: string } | undefined,
): PackProvider | undefined {
  if (!provider) return undefined;
  if (provider.kind === "opencode") return { kind: "opencode" };
  if (provider.kind === "acpx" && typeof provider.agent === "string" && provider.agent.length > 0) {
    return { kind: "acpx", agent: provider.agent };
  }
  return undefined;
}

/**
 * Returns the provider-asset subdirectory names needed for `provider`, or `null`
 * when no safe filter applies (stage/verify every declared asset tree).
 */
export function requiredProviderAssetNames(
  provider?: PackProvider,
  manifest?: Pick<ProviderPackIdentity, "payload">,
): string[] | null {
  if (!provider) return null;
  if (provider.kind === "opencode") return [];
  const agent = provider.agent;
  if (!SAFE_PROVIDER_ASSET_NAME.test(agent)) return null;
  if (manifest) {
    const declared = Object.hasOwn(manifest.payload.providers ?? {}, agent)
      || Object.hasOwn(manifest.payload.candidateProviders ?? {}, agent);
    return declared ? [agent] : [];
  }
  if ((KNOWN_NATIVE_ASSET_PROVIDERS as readonly string[]).includes(agent)) return [agent];
  if ((BUILTIN_NON_ASSET_ACPX_PROVIDERS as readonly string[]).includes(agent)) return [];
  return null;
}

/** True when a pack-relative path belongs to the staged subset for `required`. */
export function isProviderAssetPathIncluded(
  relativePath: string,
  required: readonly string[] | null,
  options?: { assetsOnly?: boolean },
): boolean {
  const isAssetTree = relativePath === "provider-assets" || relativePath.startsWith("provider-assets/");
  if (options?.assetsOnly && !isAssetTree) return false;
  if (required === null) return true;
  if (relativePath === "provider-assets") return required.length > 0;
  if (!relativePath.startsWith("provider-assets/")) return true;
  if (required.length === 0) return false;
  const segment = relativePath.slice("provider-assets/".length).split("/")[0] ?? "";
  return required.includes(segment);
}

/** GNU tar `--exclude` arguments that omit unused `provider-assets/*` trees. */
export function providerAssetExcludeArgs(input: {
  provider?: PackProvider;
  manifest?: Pick<ProviderPackIdentity, "payload">;
  filePaths?: readonly string[];
}): string[] {
  const required = requiredProviderAssetNames(input.provider, input.manifest);
  if (required === null) return [];
  if (required.length === 0) return ["--exclude=./provider-assets", "--exclude=provider-assets"];
  const known = new Set<string>(KNOWN_NATIVE_ASSET_PROVIDERS);
  for (const key of Object.keys(input.manifest?.payload.providers ?? {})) known.add(key);
  for (const key of Object.keys(input.manifest?.payload.candidateProviders ?? {})) known.add(key);
  for (const relativePath of input.filePaths ?? []) {
    if (!relativePath.startsWith("provider-assets/")) continue;
    const segment = relativePath.slice("provider-assets/".length).split("/")[0] ?? "";
    if (segment) known.add(segment);
  }
  return [...known]
    .filter(name => SAFE_PROVIDER_ASSET_NAME.test(name) && !required.includes(name))
    .sort()
    .flatMap(name => [`--exclude=./provider-assets/${name}`, `--exclude=provider-assets/${name}`]);
}

export function compatibleProviderPackInstallation<T extends ProviderPackIdentity>(
  installation: ProviderPackInstallation, expected: T, packRoot: string,
  provider: PackProvider, requireExactIdentity: boolean, requireCurrentOpenCodeProxy: boolean,
  admittedReceipt?: AdmittedProviderPackReceipt,
): T {
  const actual = installation.manifest as T | null;
  const payload = actual?.payload;
  const contract = expected.payload.compatibility?.[provider.kind];
  const pinnedReceipt = requireExactIdentity ? admittedReceipt : undefined;
  const matchesPinnedReceipt = pinnedReceipt !== undefined
    && actual?.digest === pinnedReceipt.providerPackDigest
    && payload?.artifacts?.opencodeProxy?.sha256 === pinnedReceipt.opencodeProxySha256
    && payload?.runnerSourceRevision === pinnedReceipt.sourceRevision;
  const failed = !installation.immutable ? "installation_unprotected"
    : installation.root !== packRoot ? "installation_root"
    : !payload ? "manifest_missing"
    : actual.schema !== expected.schema ? "schema"
    : actual.digest !== `sha256:${createHash("sha256").update(canonicalProviderPackJson(payload)).digest("hex")}` ? "manifest_digest"
    : canonicalProviderPackJson(payload.target) !== canonicalProviderPackJson(expected.payload.target) ? "target"
    : pinnedReceipt ? (!matchesPinnedReceipt ? "exact_identity" : null)
    : requireExactIdentity ? (actual.digest !== expected.digest ? "exact_identity" : null)
    : !Number.isSafeInteger(contract) || contract! < 1 ? "expected_compatibility_missing"
    : payload.compatibility?.[provider.kind] !== contract ? "compatibility_revision"
    : !/^sha256:[a-f0-9]{64}$/.test(expected.payload.contractDigest ?? "") ? "expected_contract_digest_missing"
    : payload.contractDigest === undefined ? "contract_digest_missing"
    : payload.contractDigest !== expected.payload.contractDigest ? "contract_digest"
    : null;
  if (failed || !actual || !payload || typeof payload.pins?.opencode !== "string") {
    throw providerPackIncompatible(failed ?? "opencode_pin_missing", "installed provider pack interface or installation is incompatible");
  }
  for (const [name, expectedArtifact] of Object.entries(expected.payload.artifacts)) {
    const artifact = payload.artifacts?.[name];
    if (artifact?.path !== expectedArtifact.path || !/^sha256:[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw providerPackIncompatible(`artifact:${name}`, "installed provider pack artifact identity is invalid");
    }
  }
  if (provider.kind === "opencode" && requireCurrentOpenCodeProxy
    && payload.artifacts.opencodeProxy?.sha256 !== expected.payload.artifacts.opencodeProxy?.sha256) {
    throw providerPackIncompatible("opencode_proxy", "installed proxy does not match the requested OpenCode diagnostics");
  }
  if (provider.kind === "acpx") {
    const agent = provider.agent;
    const currentProfile = expected.payload.acpxProfileDigests?.[agent];
    const selected = expected.payload.providers?.[agent] ?? expected.payload.candidateProviders?.[agent];
    const installed = payload.providers?.[agent] ?? payload.candidateProviders?.[agent];
    if (pinnedReceipt) {
      const installedProfile = payload.acpxProfileDigests?.[agent];
      if (!/^sha256:[a-f0-9]{64}$/.test(installedProfile ?? "") && !installed) {
        throw providerPackIncompatible("acpx_profile", "selected ACPX provider profile is incompatible");
      }
    } else if (currentProfile ? payload.acpxProfileDigests?.[agent] !== currentProfile
      : !selected || !installed || ["version", "profileDigest", "closureDigest", "qualification", "path"].some(key =>
          (installed as Record<string, unknown>)[key] !== (selected as Record<string, unknown>)[key])) {
      throw providerPackIncompatible("acpx_profile", "selected ACPX provider profile is incompatible");
    }
  }
  return structuredClone(actual);
}
