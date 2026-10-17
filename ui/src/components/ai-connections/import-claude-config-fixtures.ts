/**
 * Fixtures for the "import the local Claude config" UI suites.
 *
 * Three suites cover the feature — the onboarding connect step, the shared
 * provider step (`AgentProviderConnection`) and the credential step that wires
 * the gate (`AiConnectionCredentialStep`) — and they each need the same handful
 * of values: a health payload, an environment row, and a read result. They live
 * here so the three cannot drift apart, and so each suite stays about what its
 * own surface does with them.
 *
 * Nothing here imports an API module: these are plain values a suite feeds to
 * its own mocks.
 */

/** The one file the import reads, and the only one it will ever name. */
export const LOCAL_CLAUDE_SETTINGS_PATH = "~/.claude/settings.json";

/** The gateway address a configured machine points `ANTHROPIC_BASE_URL` at. */
export const GATEWAY = "https://gateway.example.test/v1";

/** The masked form the read answers with. The value never leaves the server. */
export const MASKED_KEY = "sk-ant-…3f9a";

/** The two credential variables, and which of them wins (PRODUCT #11). */
const ANTHROPIC_API_KEY = "ANTHROPIC_API_KEY";

/** The model tiers the read folds, in the order PRODUCT #10 lists them. */
export const MODEL_TIER_VARIABLES = [
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
] as const;

/**
 * What the server answers for each way a read comes back empty.
 *
 * Deliberately terse, and naming neither the file nor a variable: the suite
 * asserts that the *guidance* carries those (PRODUCT #14), and a server message
 * that already contained them would make that assertion pass without the
 * guidance being rendered at all. The real route words its own copy differently.
 */
export const READ_UNAVAILABLE_MESSAGES = {
  settings_unreadable: "The local Claude configuration could not be read.",
  env_block_missing: "The local Claude configuration holds no Anthropic settings.",
  base_url_missing: "No gateway is configured on this machine.",
  key_missing: "No key is configured on this machine.",
  models_missing: "No model tier is configured on this machine.",
} as const;

type ReadUnavailableReason = keyof typeof READ_UNAVAILABLE_MESSAGES;

/** A read that found a gateway, a key and a model tier (PRODUCT #10, #12). */
export function readOk(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok" as const,
    baseUrl: GATEWAY,
    keyVariable: ANTHROPIC_API_KEY,
    maskedKey: MASKED_KEY,
    models: {
      default: "claude-opus-4-6",
      alternatives: ["claude-sonnet-4-6", "claude-haiku-4-5"],
    },
    suggestedName: "Imported from Claude config",
    ...overrides,
  };
}

/**
 * A read that classified its own failure. Nothing is imported, so the card has to
 * say what to set and where (PRODUCT #14).
 */
export function readUnavailable(
  reason: ReadUnavailableReason,
  overrides: Record<string, unknown> = {},
) {
  return {
    status: "unavailable" as const,
    reason,
    message: READ_UNAVAILABLE_MESSAGES[reason],
    ...overrides,
  };
}

/**
 * Health as a `local_trusted` instance answers it: the one deployment mode the
 * import is offered on, because it is the only one whose board requests carry
 * the local operator (PRODUCT #4, #49).
 */
export function locallyTrustedHealth(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok" as const,
    deploymentMode: "local_trusted" as const,
    localAiLoginSupported: true,
    ...overrides,
  };
}

/** The environment row shape a mocked environments list carries. */
export function environmentFixture(
  driver: "local" | "ssh" | "sandbox" | "plugin",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `env-${driver}`,
    name: driver === "local" ? "This machine" : `${driver} environment`,
    status: "active",
    driver,
    config: {},
    ...overrides,
  };
}

/**
 * The 422 the import route answers with when the gateway the file names is
 * unreachable from where the agent will actually run (PRODUCT #51, #25).
 */
export const UNREACHABLE_ENVIRONMENT_422 = {
  status: 422,
  message:
    "This gateway address is unreachable for Ada, which executes outside this " +
    "machine. Import it for an agent that runs locally, or give that agent an " +
    "environment that can reach gateway.example.test.",
};
