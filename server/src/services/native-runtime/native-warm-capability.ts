import { resolvePaperclipRunnerProviderProfile, type PaperclipRunnerProviderProfile } from "./provider-profile.js";

type WarmProviderSelection = { backend: PaperclipRunnerProviderProfile["backend"]; acpxAgent?: unknown };

/**
 * The harness an agent config selects, resolved exactly as the runtime resolves
 * it (an omitted provider is Codex; ACPX without an agent is Claude). Null when
 * the runtime would refuse the config.
 */
export function resolveWarmProviderSelection(adapterConfig: unknown, companyId?: string): WarmProviderSelection | null {
  try {
    const profile = resolvePaperclipRunnerProviderProfile(adapterConfig, { companyId });
    return { backend: profile.backend, acpxAgent: profile.provider === "acpx" ? profile.acpxAgent : undefined };
  } catch {
    return null;
  }
}

/** Providers with a session-owned home and the current instruction-grant handoff. */
export function supportsNativeWarmFiles(profile: WarmProviderSelection): boolean {
  return profile.backend === "codex_app_server" ||
    (profile.backend === "acpx_runtime" && profile.acpxAgent === "copilot");
}

const PER_TURN_ONLY_BACKENDS: ReadonlySet<PaperclipRunnerProviderProfile["backend"]> = new Set([
  "openai_dot_mcp",
  "grok_bot_mcp",
  "muse_external",
  "cursor_cloud_api",
]);

const DECLARED_PROVIDER_BACKENDS: ReadonlyMap<string, PaperclipRunnerProviderProfile["backend"]> = new Map([
  ["openai_dot", "openai_dot_mcp"],
  ["grok_bot", "grok_bot_mcp"],
  ["muse", "muse_external"],
  ["cursor_cloud", "cursor_cloud_api"],
]);

function resolveDeclaredWarmProviderSelection(adapterConfig: unknown): WarmProviderSelection | null {
  if (typeof adapterConfig !== "object" || adapterConfig === null || Array.isArray(adapterConfig)) return null;
  const config = adapterConfig as Record<string, unknown>;
  if (config.provider === "acpx") {
    return { backend: "acpx_runtime", acpxAgent: config.acpxAgent ?? "claude" };
  }
  const backend = typeof config.provider === "string" ? DECLARED_PROVIDER_BACKENDS.get(config.provider) : undefined;
  return backend ? { backend } : null;
}

/**
 * Harnesses whose native sessions must always run per-turn (never warm), shared
 * by both the heartbeat native session policy and the run-scoped environment
 * lifecycle view (plugin task and sandbox lease retention):
 * - Google Antigravity (`acpx_runtime` / `antigravity`): runs turn by turn with
 *   any credential, as Kimi does with a managed key; a warm owner needs its own
 *   proof that a credential change retires it and refreshes its native home on
 *   attach, so no choice selects warm yet.
 * - `openai_dot_mcp`, `grok_bot_mcp`, `muse_external`, and `cursor_cloud_api`:
 *   external/cloud-hosted backends whose configuration validators accept only a
 *   per-turn lifecycle.
 */
export function requiresPerTurnNativeSession(profile: WarmProviderSelection): boolean {
  return (profile.backend === "acpx_runtime" && profile.acpxAgent === "antigravity")
    || PER_TURN_ONLY_BACKENDS.has(profile.backend);
}

/**
 * True when an adapter configuration targets a per-turn-only harness, including
 * when full provider-profile resolution refuses the configuration (for example,
 * a pending Antigravity rollout without a company grant, or an incomplete/invalid
 * external backend config). Keeps plugin task and sandbox lease retention aligned
 * with `requiresPerTurnNativeSession`.
 */
export function requiresPerTurnNativeSessionForConfig(adapterConfig: unknown, companyId?: string): boolean {
  const profile = resolveWarmProviderSelection(adapterConfig, companyId)
    ?? resolveDeclaredWarmProviderSelection(adapterConfig);
  return profile !== null && requiresPerTurnNativeSession(profile);
}

/** Copilot carries a token in its fenced session environment, not a temporary auth file.
 * Credential generation changes still retire the exact warm owner before attachment. */
export function supportsManagedNativeWarmSession(
  profile: WarmProviderSelection,
  attribution: { provider: string; method: string } | undefined,
): boolean {
  return profile.backend === "codex_app_server" ||
    (profile.backend === "acpx_runtime" && profile.acpxAgent === "copilot" &&
      attribution?.provider === "github" && attribution.method === "api_key");
}

/**
 * Harnesses measured to start a follow-up turn faster on a live runner
 * (doc/plans/2026-11-07-warm-follow-up-ttft.md, doc/plans/2026-11-08-large-workspace-speed.md).
 * Locally, ACPX harnesses (Claude) relaunch their provider process on every
 * follow-up turn, so warm does not shorten their follow-up. On a remote sandbox
 * the dominant cost is a new sandbox and a full workspace upload, so Claude
 * gains from warm there too.
 */
export function defaultsToWarmFollowUp(profile: WarmProviderSelection, target: "local" | "remote_sandbox"): boolean {
  if (profile.backend === "codex_app_server" || profile.backend === "opencode_server") return true;
  return target === "remote_sandbox" && profile.backend === "acpx_runtime" && profile.acpxAgent === "claude";
}

/**
 * The one rule for the remote-sandbox warm default. The run-scoped environment
 * view (lease retention) and the native session policy (runner retention) both
 * call it, and apply it only when no lifecycle was chosen anywhere (admitted
 * session, environment, agent). It holds only when the sandbox provider keeps
 * reusable leases, so a default never turns a run that works per-turn into a
 * refused warm run, and only when a selected managed AI account supports a
 * warm session.
 */
export function defaultsRemoteSandboxRunToWarm(input: {
  profile: WarmProviderSelection;
  reusableLeaseSupported: boolean;
  managedAi: { attribution?: { provider: string; method: string } } | null;
}): boolean {
  return input.reusableLeaseSupported
    && defaultsToWarmFollowUp(input.profile, "remote_sandbox")
    && (input.managedAi === null || supportsManagedNativeWarmSession(input.profile, input.managedAi.attribution));
}
