/**
 * What every surface that offers the "import the local Claude config" credential
 * mode needs to agree on.
 *
 * Four surfaces draw that mode — onboarding's own connect step, the new-agent
 * wizard, the agent configuration page and the Apps catalog flow (PRODUCT #1) —
 * and three of them reach it through the same two components. The mode is only
 * the same mode if the gate in front of it and the sentences under it are the
 * same everywhere, so both live here rather than being restated per surface: a
 * copy that drifts is how one surface ends up offering a press that cannot
 * complete (PRODUCT #50).
 *
 * Nothing here talks to the network. The gate reads the health answer the
 * surface already holds, and the server enforces all of it again on both routes
 * — this only decides whether a control nobody could complete is drawn.
 */

import type { LocalClaudeConfigReadResult } from "@paperclipai/shared";

/** The one file the import reads, and the only one it will ever name. */
export const LOCAL_CLAUDE_SETTINGS_PATH = "~/.claude/settings.json";

/**
 * What to do about each way the read can come back empty.
 *
 * Keyed by the reason the route reports rather than by its message: the sentence
 * has to name the missing variable and the file it belongs in, and the server is
 * free to reword its own copy.
 */
export const IMPORT_READ_GUIDANCE: Record<
  Extract<LocalClaudeConfigReadResult, { status: "unavailable" }>["reason"],
  string
> = {
  settings_unreadable: `Paperclip reads ${LOCAL_CLAUDE_SETTINGS_PATH} on the machine running the server. Create that file with an "env" block, then import again.`,
  env_block_missing: `Add an "env" block to ${LOCAL_CLAUDE_SETTINGS_PATH} holding ANTHROPIC_BASE_URL, a key, and a model tier, then import again.`,
  base_url_missing: `Set ANTHROPIC_BASE_URL in the "env" block of ${LOCAL_CLAUDE_SETTINGS_PATH} to your gateway address, then import again.`,
  key_missing: `Set ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the "env" block of ${LOCAL_CLAUDE_SETTINGS_PATH}, then import again.`,
  models_missing: `Set one of ANTHROPIC_DEFAULT_OPUS_MODEL, ANTHROPIC_DEFAULT_SONNET_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL or ANTHROPIC_DEFAULT_FABLE_MODEL in the "env" block of ${LOCAL_CLAUDE_SETTINGS_PATH}, then import again.`,
};

/**
 * The half of the health answer this gate reads.
 *
 * Structural rather than `HealthStatus`, so any surface holding its own shape of
 * the payload can ask: the only two fields that matter are the two the local
 * sign-in already reads.
 */
export type ClaudeConfigImportHealth =
  | {
      localAiLoginSupported?: boolean;
      deploymentMode?: string;
    }
  | undefined;

/**
 * Whether a surface may offer the import credential mode at all.
 *
 * Two conditions, and the second is the one that is easy to get wrong.
 *
 * The provider has to be Anthropic, because endpoint fields mean nothing on any
 * other (PRODUCT #3).
 *
 * The instance has to be the kind that reads local credentials
 * (`localAiLoginSupported`, the same signal the local sign-in uses — PRODUCT #4)
 * *and* `local_trusted` besides it. That deployment mode is the one whose board
 * requests carry the local operator, so it is also the only one where the caller
 * can be the operator whose home directory holds the file (PRODUCT #49) — a
 * signed-in board on an authenticated instance, however privileged, never is one.
 * Reading `deploymentMode` rather than a permission is deliberate: it is the same
 * fact, and it is the one the health payload already carries. There is no fallback
 * from `deploymentMode` to `localAiLoginSupported` either: the second is the
 * instance's own answer about whether it may read local credentials, and inferring
 * it would offer the mode to an instance that just said it could not.
 *
 * Deliberately absent: anything about the execution environment. Whether the
 * gateway is reachable from where the agent will actually run is the server's
 * call (PRODUCT #51, #53) — it knows the agent's driver and its network allowlist,
 * and a surface guessing from a driver name would refuse imports the server would
 * have accepted while still drawing the mode for the ones it would not. The gate
 * here is only about a control nobody could complete.
 */
export function canOfferClaudeConfigImport({
  provider,
  health,
}: {
  provider: string | null | undefined;
  health: ClaudeConfigImportHealth;
}): boolean {
  return (
    provider === "anthropic" &&
    health?.localAiLoginSupported === true &&
    health?.deploymentMode === "local_trusted"
  );
}

/**
 * The model an import submits: what the card holds, or the tier the read folded
 * if the free-text field was left empty.
 *
 * The card's model row is the same field it is everywhere else (PRODUCT #19), so
 * clearing it is allowed — but the route wants a model, and the folded tier is
 * the one this connection was imported for.
 */
export function resolveImportModel(
  model: string,
  snapshot: { models: { default: string } },
): string {
  return model.trim() || snapshot.models.default;
}
