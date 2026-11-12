export const CHAT_NATIVE_TIMEOUT_POLICY = {
  kind: "production-default-no-active-turn-cap",
  effectiveNativeTurnTimeoutMs: 0,
  savedAgentTimeoutSec: 0,
  lifetimeOwner: "unchanged-finite-scenario-cell-and-owned-cleanup",
} as const;

export function chatNativeTimeoutEvidence(input: {
  selectedTurnTimeoutMs: number | undefined;
  authoredLegacyTurnTimeoutMs: number;
  attemptTimeoutMs: number;
  observationBudgetMs: number;
  savedAgentTimeoutSec: unknown;
}) {
  if (input.selectedTurnTimeoutMs !== CHAT_NATIVE_TIMEOUT_POLICY.effectiveNativeTurnTimeoutMs
    || input.savedAgentTimeoutSec !== CHAT_NATIVE_TIMEOUT_POLICY.savedAgentTimeoutSec)
    throw new Error("Catalog effective native timeout differs from the production-default policy");
  if (!Number.isFinite(input.attemptTimeoutMs) || input.attemptTimeoutMs <= 30_000
    || !Number.isFinite(input.observationBudgetMs) || input.observationBudgetMs <= 0 || input.observationBudgetMs >= input.attemptTimeoutMs
    || !Number.isFinite(input.authoredLegacyTurnTimeoutMs) || input.authoredLegacyTurnTimeoutMs <= 0)
    throw new Error("Catalog requires its unchanged finite outer budget and explicit authored legacy declaration");
  return { ...CHAT_NATIVE_TIMEOUT_POLICY,
    authoredLegacyTurnTimeoutMs: input.authoredLegacyTurnTimeoutMs,
    scenarioCellBudgetMs: input.attemptTimeoutMs,
    scenarioObservationBudgetMs: input.observationBudgetMs,
    playwrightBudgetMs: input.attemptTimeoutMs + 90_000,
    launcherWatchdogMs: input.attemptTimeoutMs + 90_000 + 300_000,
    activeRunCancellationWaitMs: 45_000,
    ownedProcessShutdownGraceMs: 45_000,
    ownedProcessKillGraceMs: 5_000,
  };
}
