import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, environments, instanceSettings, type Db } from "@paperclipai/db";
import {
  type LocalClaudeConfigImportInput,
  type LocalClaudeConfigReadResult,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Anthropic's two credential variables authenticate with different headers, so
 * a connection has to remember which one its key came from. `ANTHROPIC_API_KEY`
 * wins when the operator configured both (PRODUCT #11).
 */
export const ANTHROPIC_KEY_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;
export type AnthropicKeyVariable = (typeof ANTHROPIC_KEY_VARIABLES)[number];

/** Model tiers, strongest first. The first one with a value folds to the default (PRODUCT #12). */
const MODEL_TIER_VARIABLES = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

/**
 * The only keys this feature ever lifts out of the operator's settings file.
 * Everything else in `env` — timeouts, subagent limits, traffic switches — is
 * dropped, because none of it belongs in an agent's run environment (PRODUCT #10).
 */
const IMPORTED_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  ...ANTHROPIC_KEY_VARIABLES,
  ...MODEL_TIER_VARIABLES,
] as const;

/** The connection name a fresh import suggests, so its origin is visible in the list. */
const SUGGESTED_CONNECTION_NAME = "Imported from Claude config";

/**
 * The one file this feature reads. It is derived from the current user's home
 * directory and nothing else: no caller can point it at another path, and it is
 * deliberately not `~/.claude.json` (PRODUCT #8, #42).
 */
export function localClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function envValue(env: Record<string, unknown>, key: string): string | null {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function unavailable(
  reason: Extract<LocalClaudeConfigReadResult, { status: "unavailable" }>["reason"],
  message: string,
): LocalClaudeConfigReadResult {
  return { status: "unavailable", reason, message };
}

/**
 * Show just enough of a credential for the operator to recognize which key it
 * is. The value itself never leaves this module (PRODUCT #17, #41).
 */
export function maskSecretValue(value: string): string {
  if (value.length <= 10) return `…${value.slice(-4)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * The one canonical shape of a gateway address, shared by the probe and by
 * runtime injection. A trailing slash and an already-present `/v1` segment must
 * both be absorbed, otherwise the probe address ends up with a doubled or a
 * missing path segment (PRODUCT #16). This is stricter than the adapter's own
 * `resolveAnthropicBaseUrl()`, which only strips trailing slashes.
 */
/**
 * One canonical spelling of an operator's gateway address.
 *
 * The canonical form deliberately carries **no** `/v1`: the value is written
 * straight into the child's `ANTHROPIC_BASE_URL`, and the Claude CLI appends
 * `/v1/messages` itself. Keeping the segment would make every run request
 * `/v1/v1/messages`. The repo's own discovery call makes the same assumption —
 * `packages/adapters/claude-local/src/server/models.ts` appends `/v1/models`
 * to this variable — so a `/v1`-carrying value breaks model discovery too.
 * Callers that need an API path append it (`/v1/models` for the probe).
 *
 * An operator may have appended the segment more than once, so strip it
 * repeatedly; any other path segment is a real gateway prefix and stays.
 */
export function normalizeGatewayBaseUrl(raw: string): string {
  const parsed = new URL(raw.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new Error("The gateway address must use http or https");
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("The gateway address must not carry credentials or a query");
  let path = parsed.pathname.replace(/\/+$/, "");
  while (path.endsWith("/v1")) path = path.slice(0, -"/v1".length).replace(/\/+$/, "");
  return `${parsed.origin}${path}`;
}

/** Fold the tier ladder into one default plus the alternatives the user may still pick (PRODUCT #12). */
export function resolveImportedModel(
  tiers: readonly string[],
): { default: string; alternatives: string[] } {
  const present = [...new Set(tiers.map((tier) => tier.trim()).filter(Boolean))];
  return { default: present[0]!, alternatives: present.slice(1) };
}

/** What a successful read holds in server memory: the plaintext key lives only here. */
export type LocalClaudeConfigSnapshot = {
  baseUrl: string;
  keyVariable: AnthropicKeyVariable;
  key: string;
  models: { default: string; alternatives: string[] };
};

/**
 * Read the operator's own Claude settings file. Every failure comes back as a
 * classified result rather than a stack trace, so the surface can point at the
 * file and the variable that is missing (PRODUCT #14).
 */
export async function readLocalClaudeConfig(): Promise<LocalClaudeConfigReadResult> {
  return (await readLocalClaudeConfigWithKey()).result;
}

/**
 * The single read behind both the safe response and the import: reading twice
 * would let the file change between the two, and the import's whole guarantee is
 * that it compared against what it is about to save.
 */
async function readLocalClaudeConfigWithKey(): Promise<
  { result: LocalClaudeConfigReadResult; key: string }
> {
  const file = localClaudeSettingsPath();
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return {
      result: unavailable(
        "settings_unreadable",
        `Could not read the local Claude configuration at ${file}. Make sure the file exists on the machine running Paperclip.`,
      ),
      key: "",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      result: unavailable(
        "settings_unreadable",
        `Could not read the local Claude configuration at ${file}. The file is not valid JSON.`,
      ),
      key: "",
    };
  }
  const block = (parsed as { env?: unknown } | null)?.env;
  const env = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
  const imported = Object.fromEntries(
    IMPORTED_ENV_KEYS.map((key) => [key, envValue(env, key)]).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  ) as Partial<Record<(typeof IMPORTED_ENV_KEYS)[number], string>>;
  if (!Object.keys(imported).length)
    return {
      result: unavailable(
        "env_block_missing",
        `Could not read the local Claude configuration at ${file}. It has no env block with any Anthropic setting.`,
      ),
      key: "",
    };
  let baseUrl: string;
  try {
    baseUrl = normalizeGatewayBaseUrl(imported.ANTHROPIC_BASE_URL ?? "");
  } catch {
    return {
      result: unavailable(
        "base_url_missing",
        `ANTHROPIC_BASE_URL in ${file} is not a usable http or https URL. Set it to your gateway address.`,
      ),
      key: "",
    };
  }
  const models = resolveImportedModel(
    MODEL_TIER_VARIABLES.map((key) => imported[key]).filter(
      (value): value is string => Boolean(value),
    ),
  );
  if (!models.default)
    return {
      result: unavailable(
        "models_missing",
        `ANTHROPIC_BASE_URL is set in ${file} but no model tier is. Set ANTHROPIC_DEFAULT_OPUS_MODEL (or SONNET, HAIKU, FABLE) and import again.`,
      ),
      key: "",
    };
  const keyVariable = ANTHROPIC_KEY_VARIABLES.find((key) => imported[key]);
  if (!keyVariable)
    return {
      result: unavailable(
        "key_missing",
        `ANTHROPIC_BASE_URL is set in ${file} but no key is. Set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN and import again.`,
      ),
      key: "",
    };
  return {
    result: {
      status: "ok",
      baseUrl,
      keyVariable,
      maskedKey: maskSecretValue(imported[keyVariable]!),
      models,
      suggestedName: SUGGESTED_CONNECTION_NAME,
    },
    key: imported[keyVariable]!,
  };
}

/** What a read hands its caller: either the summary plus the plaintext key, or why there is none. */
export type LocalClaudeConfigSnapshotResult =
  | { ok: true; result: Extract<LocalClaudeConfigReadResult, { status: "ok" }>; snapshot: LocalClaudeConfigSnapshot }
  | { ok: false; result: Extract<LocalClaudeConfigReadResult, { status: "unavailable" }> };

/**
 * Read the file and keep the plaintext key, which only the caller that goes on
 * to save the connection ever sees.
 */
export async function readLocalClaudeConfigSnapshot(): Promise<LocalClaudeConfigSnapshotResult> {
  const read = await readLocalClaudeConfigWithKey();
  if (read.result.status !== "ok") return { ok: false, result: read.result };
  return {
    ok: true,
    result: read.result,
    snapshot: {
      baseUrl: read.result.baseUrl,
      keyVariable: read.result.keyVariable,
      key: read.key,
      models: read.result.models,
    },
  };
}

/**
 * Prove the gateway accepts this key before anything is written. `redirect` and
 * the 15s ceiling match the official API-key check; a redirect is never
 * followed, so a key cannot be handed to a host the operator did not configure
 * (PRODUCT #21, #23).
 */
export async function verifyGatewayEndpoint(
  baseUrl: string,
  key: string,
  keyVariable: AnthropicKeyVariable | undefined,
  request: typeof fetch = fetch,
) {
  // The canonical form carries no /v1 (see normalizeGatewayBaseUrl), so the
  // API path is appended here rather than baked into the stored value.
  const probeUrl = `${normalizeGatewayBaseUrl(baseUrl)}/v1/models`;
  // The two Anthropic credential variables travel under different headers, so
  // the probe has to use the one the connection was imported from: a gateway
  // that only accepts one of them rejects the other.
  const headers: Record<string, string> =
    keyVariable === "ANTHROPIC_AUTH_TOKEN"
      ? { Authorization: `Bearer ${key}` }
      : { "x-api-key": key, "anthropic-version": "2023-06-01" };
  let response: Response;
  try {
    response = await request(probeUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers,
    });
  } catch {
    throw unprocessable(
      "Could not reach the gateway. Check the address in this machine's Claude settings and try again.",
      { code: "ai_connection_verification_failed" },
    );
  }
  await response.body?.cancel();
  if (!response.ok)
    throw unprocessable(
      response.status === 401 || response.status === 403
        ? "The gateway rejected this key. If this machine's settings.json sets both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN, the imported variable may be the wrong one: they authenticate differently. Change the file and import again."
        : "The gateway returned a response this app could not read. Try again.",
      {
        code:
          response.status === 401 || response.status === 403
            ? "ai_connection_api_key_rejected"
            : "ai_connection_verification_failed",
      },
    );
}

/**
 * Whether an allowlist entry covers the gateway, under the same rules the
 * local-process sandbox proxy applies (`isNetworkTargetAllowed`): the hostname
 * matches exactly, and an entry that names a port must match the gateway's
 * effective port. An entry without a port covers every port, so a bare
 * `gateway.example` still admits `https://gateway.example:9443`.
 */
function allowlistCovers(allowlist: unknown, gateway: URL): boolean {
  if (!Array.isArray(allowlist)) return false;
  const hostname = gateway.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = gateway.port || (gateway.protocol === "https:" ? "443" : "80");
  return allowlist.some((entry) => {
    if (typeof entry !== "string" || !entry.trim()) return false;
    const candidate = entry.trim().includes("://")
      ? entry.trim()
      : `https://${entry.trim()}`;
    try {
      const rule = new URL(candidate);
      return rule.hostname.toLowerCase() === hostname && (!rule.port || rule.port === port);
    } catch {
      return false;
    }
  });
}

/**
 * The instance policy that moved a run off the environment its own resolution
 * picked. Two of them exist, and they are not the same knob, so a rejection has
 * to name which one applies.
 */
type ForcedExecutionPolicy = "managed_sandbox" | "kubernetes";

/** The instance execution policies the heartbeat applies after environment resolution. */
type ForcedExecutionPolicies = {
  /** `enableManagedSandboxOnly` (experimental): a run landing on local is redirected to the managed sandbox. */
  managedSandboxOnly: boolean;
  /** `general.executionMode === "kubernetes"`: every run is forced onto the Kubernetes sandbox. */
  kubernetesOnly: boolean;
};

/**
 * Read the two execution policies through the settings service rather than off
 * the table, so the managed-config and operator-default overlays apply here
 * exactly as they do at run time (see `instanceSettingsService`).
 */
async function forcedExecutionPolicies(db: Db): Promise<ForcedExecutionPolicies> {
  const settings = instanceSettingsService(db);
  const [experimental, general] = await Promise.all([
    settings.getExperimental(),
    settings.getGeneral(),
  ]);
  return {
    managedSandboxOnly: experimental.enableManagedSandboxOnly === true,
    kubernetesOnly: general.executionMode === "kubernetes",
  };
}

/**
 * Whether a policy moves execution away from the environment that was resolved
 * for a run. Mirrors `resolveExecutionWorkspaceEnvironmentId` plus heartbeat's
 * Kubernetes forcing:
 *
 * - `executionMode: "kubernetes"` wins over everything and moves every run,
 *   whichever environment was resolved.
 * - `enableManagedSandboxOnly` redirects only a run that landed on the local
 *   environment. A non-local pick is the operator's own choice and is already
 *   refused elsewhere, so the policy says nothing new about it.
 *
 * Both destinations are `sandbox` drivers, so a moved run is never local, and
 * with no such environment configured the run fails closed at run time rather
 * than falling back to local — the import has to refuse either way.
 */
function forcedExecutionOverride(
  policies: ForcedExecutionPolicies,
  resolvedEnvironmentId: string | null,
  localEnvironmentId: string | null,
): ForcedExecutionPolicy | null {
  if (policies.kubernetesOnly) return "kubernetes";
  if (policies.managedSandboxOnly && resolvedEnvironmentId === localEnvironmentId)
    return "managed_sandbox";
  return null;
}

/**
 * The rejection for an environment a policy moved. It names the policy rather
 * than the environment that was resolved, because that environment was chosen
 * on purpose: blaming it would send the operator to look at the wrong setting.
 */
function unreachableUnderPolicy(
  policy: ForcedExecutionPolicy,
  subject: string,
  gatewayHost: string,
) {
  const cause =
    policy === "kubernetes"
      ? "this instance runs every agent in its Kubernetes sandbox (executionMode is kubernetes)"
      : "this instance runs agents only in its managed sandbox environment";
  const remedy =
    policy === "kubernetes"
      ? 'Use a gateway address the Kubernetes sandbox can reach, or set the instance execution mode to "any" before importing.'
      : "Use a gateway address the managed sandbox can reach, or turn the managed-sandbox-only setting off before importing.";
  return `This gateway address is unreachable for ${subject}: ${cause}, so execution does not happen on this machine and cannot reach ${gatewayHost}. ${remedy}`;
}

/**
 * A green probe only proves the Paperclip server can reach the gateway. An agent
 * that executes somewhere else needs its own verdict, and an egress allowlist is
 * the same class of unreachability (PRODUCT #51, #53). The judgement is about
 * the agents this surface is importing for, never about the server itself
 * (PRODUCT #52).
 *
 * What counts as "somewhere else" is the environment a run actually lands in,
 * which is not always the one its own resolution picked: the heartbeat applies
 * the two instance execution policy overrides below after resolving, so they
 * belong to this verdict too. Miss them and the import lands green while every
 * run fails.
 */
export async function assertImportedGatewayReachable(
  db: Db,
  companyId: string,
  input: Pick<LocalClaudeConfigImportInput, "agentIds" | "allAgents" | "environmentId" | "connectionId">,
  baseUrl: string,
) {
  const [localEnvironment] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(eq(environments.driver, "local"))
    .limit(1);
  const [instanceDefault] = await db
    .select({ defaultEnvironmentId: instanceSettings.defaultEnvironmentId })
    .from(instanceSettings)
    .limit(1);
  const policies = await forcedExecutionPolicies(db);
  const resolveEnvironmentId = (agentDefault: string | null) =>
    agentDefault ?? instanceDefault?.defaultEnvironmentId ?? localEnvironment?.id ?? null;
  // Reachability is judged for the agents this setup actually serves: the ones
  // the surface named, the ones already using the account a re-import repairs,
  // or — for a surface with no agent yet — the environment it resolved. Company
  // wide access is an authorization fact, not a reachability one: an unrelated
  // agent that runs in a sandbox must not block an import for a new local one.
  const targetAgentIds = input.agentIds.length
    ? input.agentIds
    : input.connectionId
      ? (
          await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(
              eq(agents.companyId, companyId),
              sql`${agents.runtimeConfig}->'aiConnection'->>'connectionId' = ${input.connectionId}`,
            ))
        ).map((row) => row.id)
      : [];
  const targets = targetAgentIds.length
    ? await db
        .select({
          id: agents.id,
          name: agents.name,
          defaultEnvironmentId: agents.defaultEnvironmentId,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), inArray(agents.id, targetAgentIds)))
    : [];
  const gatewayUrl = new URL(baseUrl);
  const gatewayHost = gatewayUrl.hostname;
  /** Whether an instance policy moves execution off the environment a run resolved to. */
  const forcedFor = (resolvedEnvironmentId: string | null) =>
    forcedExecutionOverride(policies, resolvedEnvironmentId, localEnvironment?.id ?? null);
  for (const agent of targets) {
    const environmentId = resolveEnvironmentId(agent.defaultEnvironmentId);
    const forced = forcedFor(environmentId);
    if (forced)
      throw unprocessable(unreachableUnderPolicy(forced, agent.name, gatewayHost), {
        code: "ai_connection_environment_unreachable",
      });
    const [environment] = environmentId
      ? await db
          .select({ driver: environments.driver })
          .from(environments)
          .where(eq(environments.id, environmentId))
          .limit(1)
      : [];
    if (environment && environment.driver !== "local")
      throw unprocessable(
        `This gateway address is unreachable for ${agent.name}, which executes outside this machine. Import it for an agent that runs locally, or give that agent an environment that can reach ${gatewayHost}.`,
        { code: "ai_connection_environment_unreachable" },
      );
    const networkScope = agent.adapterConfig?.networkScope;
    // An agent with egress disabled cannot reach the gateway either, and the
    // server probe succeeding proves nothing about it: the import would report
    // success until the operator tests or runs the agent.
    if (networkScope === "deny")
      throw unprocessable(
        `${agent.name} has network egress disabled, so it cannot reach this gateway. Enable its network access, or import for an agent that can reach ${gatewayHost}.`,
        { code: "ai_connection_network_denied" },
      );
    if (networkScope === "allowlist" && !allowlistCovers(agent.adapterConfig?.networkAllowlist, gatewayUrl))
      throw unprocessable(
        `Add ${gatewayHost} to ${agent.name}'s network allowlist: that agent's network egress is limited to an allowlist, and the gateway host is not on it.`,
        { code: "ai_connection_network_allowlist" },
      );
  }
  // A surface with no agent yet — onboarding, the new-agent wizard — still has
  // to refuse an import for a default environment nobody can reach, and the
  // instance policies move that environment just as they move an agent's. A
  // surface that selected an environment for the agent it is about to create
  // names it, and that choice outranks the instance default: the operator
  // picked where this agent runs, and the import is judged there.
  if (!targets.length) {
    const environmentId = input.environmentId ?? instanceDefault?.defaultEnvironmentId ?? localEnvironment?.id ?? null;
    const forced = forcedFor(environmentId);
    if (forced)
      throw unprocessable(
        unreachableUnderPolicy(forced, "the default execution environment", gatewayHost),
        { code: "ai_connection_environment_unreachable" },
      );
    const [environment] = environmentId
      ? await db
          .select({ driver: environments.driver })
          .from(environments)
          .where(eq(environments.id, environmentId))
          .limit(1)
      : [];
    if (environment && environment.driver !== "local")
      throw unprocessable(
        `This gateway address is unreachable in the default execution environment, which does not run on this machine.`,
        { code: "ai_connection_environment_unreachable" },
      );
  }
}
