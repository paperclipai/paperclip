/**
 * Refuse to persist an `adapterConfig.model` the agent's own adapter cannot serve.
 *
 * Why this exists
 * ---------------
 * `agent_config:update` has an `allow_self` branch: an agent may rewrite its own
 * `adapterConfig` with its own key and no change grant. Nothing downstream checked
 * the model against the adapter, so one self-write could set a `claude_local` agent
 * to an OpenAI model id. The Claude CLI then rejects every dispatch at the first
 * model call, the agent goes dark, and it cannot re-exercise `allow_self` to undo
 * the write — while the repair needs `agents:configure`, a grant no agent here
 * holds. A one-way door any actor may walk through alone but none may walk back.
 *
 * Refusing the write at 422 is the only place the asymmetry closes: after the write
 * lands there is no actor left with both the right and the ability to revert it.
 *
 * What it validates, and what it deliberately leaves alone
 * -------------------------------------------------------
 * Only the model the CALLER NAMED in this write. A model the server derived — an
 * adapter default, or the value `paperclipRunnerTransitionConfig` carries forward
 * across an adapter-type change — is the server's own choice and is not second
 * guessed. Rejecting one would 422 a request over a value its sender never typed,
 * and carry-forward cannot brick anything anyway: it preserves a model the agent
 * was already running, and only within one provider family (`provider ===
 * previousProvider ? previousModel : undefined`). `model` is not in
 * `ADAPTER_AGNOSTIC_KEYS`, so no other path carries it across a type change.
 *
 * Enforcement is also OPT-IN per adapter (`ENUMERATED_MODEL_SPACES`). An adapter is
 * enforced only once someone has established that its catalog names every model it
 * can serve AND that the catalog never shrinks below a static fallback on a
 * discovery failure — otherwise a transient network fault would start rejecting
 * valid models, which is the same lock-out in reverse. Every other adapter keeps
 * today's behaviour exactly, so this cannot regress an adapter nobody has checked.
 *
 * Two further exemptions, each load-bearing:
 *
 *  - Re-sending the model the agent ALREADY has, under an unchanged adapter type,
 *    is allowed. An agent sitting on an off-catalog model (set before this guard,
 *    or since retired upstream) must stay editable by clients that echo the whole
 *    config back — otherwise the guard makes every unrelated field of that agent
 *    permanently unwritable, recreating the defect it fixes. This mirrors
 *    `assertSelectableAdapterType`, which leaves existing agents on a
 *    since-disabled adapter alone.
 *  - `alsoAccept` covers models whose validity depends on state the server process
 *    cannot see. `claude_local` is the live case: a Bedrock model id is correct
 *    when the AGENT's `adapterConfig.env` selects Bedrock, but the catalog is built
 *    from the SERVER's env, so the server cannot tell a Bedrock agent from a typo.
 *
 * When the catalog is not authoritative FOR THIS AGENT
 * ---------------------------------------------------
 * Both exemptions above answer the same question — is the server's catalog a bound
 * on what this agent can run? Two cases answer no outright, and both skip
 * enforcement rather than guess:
 *
 *  - The agent re-points its adapter at another provider through its OWN
 *    `adapterConfig.env` (`providerCredentialEnvVars` / `providerSwitchEnvFlags`).
 *    Discovery reads the SERVER's key and base URL (`loadClaudeModels` →
 *    `process.env.ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`; `loadCodexModels` →
 *    `process.env.OPENAI_API_KEY`), while execution merges the agent's `config.env`
 *    into the spawned process. An agent behind an Anthropic-compatible gateway can
 *    therefore run models the server has never heard of, and enforcing the server's
 *    list would 422 a configuration that works — forcing every gateway operator to
 *    restate their models in `PAPERCLIP_ADAPTER_MODELS` to keep writing configs.
 *    This generalizes the Bedrock case: Bedrock is simply the redirect this file
 *    could already name a predicate for.
 *  - An EXTERNAL adapter has overridden the builtin for that type. The entries below
 *    were verified by reading the builtin loaders; an override replaces the
 *    implementation while keeping the type string, and `models` is optional for
 *    adapter authors, so the verification no longer holds. Enforcement follows the
 *    implementation that was checked, not the name it registered under.
 */

import { isBedrockModelId } from "@paperclipai/adapter-claude-local/server";

export const ADAPTER_MODEL_REJECTION_CODE = "adapter_cannot_serve_model";

/** Keeps the 422 body readable when an adapter lists dozens of models. */
const MAX_MODELS_IN_MESSAGE = 12;

export interface AdapterModel {
  id: string;
  label: string;
}

/** Loads the selectable catalog for an adapter type — `listAdapterModels` in production. */
export type AdapterModelCatalogLoader = (adapterType: string) => Promise<AdapterModel[]>;

interface EnumeratedModelSpace {
  /**
   * Accepts a model that is absent from the catalog but still valid. Used where
   * validity depends on per-agent state the catalog cannot observe.
   */
  alsoAccept?: (model: string) => boolean;
  /**
   * `adapterConfig.env` names that supply a provider endpoint or credential of the
   * agent's own. Any non-empty value means the agent is not served by the endpoint
   * discovery read, so the catalog bounds nothing for it.
   */
  providerCredentialEnvVars?: readonly string[];
  /**
   * `adapterConfig.env` names that switch the adapter to another backend when
   * ENABLED. Checked with the adapter's own truthiness rule rather than presence,
   * so an explicit `"0"` / `"false"` still gets the catalog check.
   */
  providerSwitchEnvFlags?: readonly string[];
}

/** `isBedrockEnv()` in the claude-local model loader accepts exactly these. */
const ENABLED_ENV_FLAG_VALUES = new Set(["1", "true"]);

/**
 * Adapters whose catalog is authoritative: it enumerates every model the harness
 * can serve, and a discovery outage degrades to a static fallback rather than to an
 * empty list. Verified per entry — do not add one without reading its model loader.
 *
 *  - `claude_local`  — `loadClaudeModels` returns `DIRECT_MODELS` (or `BEDROCK_MODELS`
 *                      under a Bedrock env) and merges discovered models on top; a
 *                      failed fetch returns the fallback, never `[]`.
 *  - `codex_local`   — `loadCodexModels` merges discovery with `codexFallbackModels`
 *                      and returns the fallback with no key or on fetch failure.
 *
 * Not enumerated, with reasons:
 *  - `opencode_local` — real model space is `provider/model` over OpenRouter and
 *    whatever `opencode models` reports; the static list is a convenience subset,
 *    not a bound. It has its own validator (`requireOpenCodeModelId`).
 *  - `hermes`, `hermes_gateway`, `process` — ship `models: []` (open-ended).
 *  - `paperclip_runner` — not enforced under its own type, but a runner whose
 *    provider maps onto an enumerated adapter inherits that adapter's enforcement
 *    through `resolveModelCatalogAdapterType`.
 */
const ENUMERATED_MODEL_SPACES = new Map<string, EnumeratedModelSpace>([
  [
    "claude_local",
    {
      alsoAccept: isBedrockModelId,
      providerCredentialEnvVars: [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_VERTEX_BASE_URL",
        "ANTHROPIC_VERTEX_PROJECT_ID",
      ],
      providerSwitchEnvFlags: ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
    },
  ],
  [
    "codex_local",
    {
      providerCredentialEnvVars: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    },
  ],
]);

/**
 * The adapter type whose catalog backs `adapterType` + `provider`.
 *
 * `paperclip_runner` does not serve models itself — it delegates to a provider, and
 * the models route resolves the same way for the picker. Returns `null` when the
 * catalog is remote and open-ended, so the caller skips enforcement rather than
 * reaching for a list that does not bound anything.
 */
export function resolveModelCatalogAdapterType(
  adapterType: string,
  provider: string | null,
): string | null {
  if (adapterType === "opencode_local" && provider === "openrouter") return null;
  if (adapterType !== "paperclip_runner") return adapterType;
  if (provider === "acpx" || provider === "claude_managed") return "claude_local";
  if (provider === "opencode") return "opencode_local";
  if (provider === "aws_agentcore") return "paperclip_runner";
  return "codex_local";
}

export type AdapterModelVerdict =
  | {
      ok: true;
      reason:
        | "not_requested"
        | "unchanged"
        | "adapter_not_enumerated"
        | "adapter_overridden"
        | "agent_scoped_provider"
        | "open_catalog"
        | "also_accepted"
        | "in_catalog";
    }
  | {
      ok: false;
      model: string;
      adapterType: string;
      catalogAdapterType: string;
      available: string[];
    };

export interface AdapterModelGuardInput {
  /** The adapter type the write would persist. */
  adapterType: string | null | undefined;
  /**
   * The model the caller named in this write, or `undefined` when it named none.
   * A server-derived model is never passed here — see the module comment.
   */
  requestedModel: unknown;
  /**
   * The effective adapter config the write would persist. Read for the `provider`
   * that selects which catalog a `paperclip_runner` delegates to, and for the `env`
   * that can point the adapter at a provider the server's catalog does not describe.
   */
  adapterConfig: Record<string, unknown>;
  /** What the agent already has. Absent on create/hire. */
  previous?: {
    adapterType: string | null | undefined;
    model: unknown;
  } | null;
}

export interface AdapterModelGuardOptions {
  /**
   * True when an external adapter currently serves this built-in type. Injected
   * because the guard must not import the registry — `isBuiltinTypeOverridden` in
   * production. Absent means "no override", which is the only safe default for a
   * caller that cannot tell: it keeps today's enforcement on a stock install.
   */
  isAdapterOverridden?: (adapterType: string) => boolean;
}

function normalizeModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The `adapterConfig.env` name through which this agent supplies its own provider,
 * or `null` when it supplies none.
 *
 * Values arrive from a JSON body, so a non-string is possible; only a non-empty
 * string counts. A flag is read with the adapter's own truthiness rule so that
 * `CLAUDE_CODE_USE_BEDROCK: "0"` — an explicit "stay on the default provider" —
 * does not buy an exemption.
 */
function findAgentScopedProviderEnvVar(
  adapterConfig: Record<string, unknown>,
  space: EnumeratedModelSpace,
): string | null {
  const env = adapterConfig.env;
  if (typeof env !== "object" || env === null || Array.isArray(env)) return null;
  const entries = env as Record<string, unknown>;

  for (const name of space.providerCredentialEnvVars ?? []) {
    if (normalizeModel(entries[name])) return name;
  }
  for (const name of space.providerSwitchEnvFlags ?? []) {
    const value = normalizeModel(entries[name]);
    if (value && ENABLED_ENV_FLAG_VALUES.has(value.toLowerCase())) return name;
  }
  return null;
}

/**
 * Decide whether `adapterType` can serve the requested model.
 *
 * The catalog loader is injected so this stays testable without the adapter
 * registry.
 *
 * Nothing here is wrapped in a try/catch, and that is the fail-open design rather
 * than a gap in it. A discovery outage does not reach this function as an
 * exception: both enumerated loaders absorb it and degrade to a static fallback —
 * `fetchAnthropicModels` catches its own fetch error and returns `[]`, and
 * `loadClaudeModels` then returns `DIRECT_MODELS`. An outage therefore arrives as
 * a short or empty catalog and is answered by `open_catalog` below, which is the
 * fail-open path.
 *
 * What is left, if `loadCatalog` throws anyway, is a deterministic fault — an
 * unreadable config while resolving a key, a malformed `PAPERCLIP_ADAPTER_MODELS`,
 * a defect in this guard. Approving the write on those would silently skip the
 * check for as long as the fault lasts, which is the hole this file exists to
 * close. So the exception propagates: the write fails loudly and is recoverable,
 * while the write this guard refuses is not.
 */
export async function evaluateAdapterModel(
  input: AdapterModelGuardInput,
  loadCatalog: AdapterModelCatalogLoader,
  options: AdapterModelGuardOptions = {},
): Promise<AdapterModelVerdict> {
  const adapterType = typeof input.adapterType === "string" ? input.adapterType.trim() : "";
  if (!adapterType) return { ok: true, reason: "not_requested" };

  const model = normalizeModel(input.requestedModel);
  if (!model) return { ok: true, reason: "not_requested" };

  const previous = input.previous;
  if (
    previous
    && previous.adapterType === adapterType
    && normalizeModel(previous.model) === model
  ) {
    return { ok: true, reason: "unchanged" };
  }

  const catalogAdapterType = resolveModelCatalogAdapterType(
    adapterType,
    normalizeModel(input.adapterConfig.provider),
  );
  if (!catalogAdapterType) return { ok: true, reason: "adapter_not_enumerated" };

  const space = ENUMERATED_MODEL_SPACES.get(catalogAdapterType);
  if (!space) return { ok: true, reason: "adapter_not_enumerated" };

  // The verified loader is the builtin's. An override keeps the type string but
  // replaces the implementation, and `models` is optional for adapter authors.
  if (options.isAdapterOverridden?.(catalogAdapterType)) {
    return { ok: true, reason: "adapter_overridden" };
  }

  // Discovery reads the SERVER's provider env; execution merges the AGENT's. When
  // the agent brings its own endpoint or credential, the catalog bounds nothing.
  if (findAgentScopedProviderEnvVar(input.adapterConfig, space)) {
    return { ok: true, reason: "agent_scoped_provider" };
  }

  // Not wrapped in a try/catch on purpose — see the note above `loadCatalog`.
  const catalog = await loadCatalog(catalogAdapterType);
  if (catalog.length === 0) return { ok: true, reason: "open_catalog" };

  if (catalog.some((entry) => entry.id.trim() === model)) {
    return { ok: true, reason: "in_catalog" };
  }
  if (space.alsoAccept?.(model)) return { ok: true, reason: "also_accepted" };

  return {
    ok: false,
    model,
    adapterType,
    catalogAdapterType,
    available: catalog.map((entry) => entry.id),
  };
}

/**
 * The 422 body for a refused write. Names BOTH values, because the failure this
 * replaces named neither: the agent died with "There's an issue with the selected
 * model (…)" in a run log, minutes later, with no path back to the write.
 */
export function adapterModelRejectionMessage(
  verdict: Extract<AdapterModelVerdict, { ok: false }>,
): string {
  const shown = verdict.available.slice(0, MAX_MODELS_IN_MESSAGE);
  const overflow = verdict.available.length - shown.length;
  const available = overflow > 0
    ? `${shown.join(", ")} (+${overflow} more)`
    : shown.join(", ");
  return (
    `Model "${verdict.model}" is not available on adapter "${verdict.adapterType}". `
    + `Available models: ${available}. `
    + "Declare the model in PAPERCLIP_ADAPTER_MODELS if this instance serves one the catalog does not list."
  );
}
