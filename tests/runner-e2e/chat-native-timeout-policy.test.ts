import { expect, it } from "vitest";
import { runnerMatrix, runnerSuites } from "./catalog.js";
import { chatCatalogCases } from "./chat-catalog-registry.js";
import { chatFeatureProfile } from "./chat-feature-cases.js";
import { CHAT_NATIVE_TIMEOUT_POLICY, chatNativeTimeoutEvidence } from "./chat-native-timeout-policy.js";
import type { RunnerProfileFixture } from "./types.js";

it("uses the production native cap only in the catalog while preserving every finite scenario budget and run bound", () => {
  const cells = runnerMatrix.filter(row => row.suite.id === "chat-features" && row.profile.id === "runner-opencode");
  expect(cells).toHaveLength(244);
  for (const cell of cells) {
    expect(cell.task.turnTimeoutMs).toBe(["create-backlog", "delegate-announcement"].includes(cell.task.id) ? 120_000 : 0);
    const declaration = chatCatalogCases.find(row => row.scenarioId === cell.task.id);
    if (declaration) {
      expect(cell.task.attemptTimeoutMs).toEqual({ local: declaration.attemptTimeoutMs, daytona: declaration.attemptTimeoutMs });
      expect(cell.task.expectedRunCount).toBe(declaration.expectedRunCount);
      expect(cell.task.minimumExpectedRunCount).toBe(declaration.minimumRunCount);
      expect(declaration.turnTimeoutMs).toBeGreaterThan(0);
    }
    expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
  }
  const byId = (id: string) => cells.find(row => row.task.id === id)!;
  expect(byId("projects.create-project").task).toMatchObject({ expectedRunCount: 2, attemptTimeoutMs: { local: 420_000 } });
  expect(byId("projects.project-work").task).toMatchObject({ expectedRunCount: 3, minimumExpectedRunCount: 1, attemptTimeoutMs: { local: 300_000 } });
  expect(byId("tasks.organize-open-work").task.attemptTimeoutMs.local).toBe(600_000);
  expect(runnerSuites.find(row => row.id === "chat-features")?.definitionMetadata).toMatchObject({ nativeTimeoutPolicy: CHAT_NATIVE_TIMEOUT_POLICY });
  expect(runnerMatrix.filter(row => row.suite.id !== "chat-features").some(row => (row.task.turnTimeoutMs ?? 0) > 0)).toBe(true);
});

it("saves the actual catalog profile with no native cap without removing funding, daily admission or unrelated adapter settings", () => {
  const original = { adapterConfig: { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", timeoutSec: 120, retained: true }, runtimeConfig: { retained: true } };
  const profile = { id: "runner-opencode", provider: "opencode", buildAgent: () => structuredClone(original) } as unknown as RunnerProfileFixture;
  const input = {} as Parameters<RunnerProfileFixture["buildAgent"]>[0];
  const saved = chatFeatureProfile(profile).buildAgent(input);
  expect(saved.adapterConfig).toEqual({ ...original.adapterConfig, timeoutSec: 0 });
  expect(saved.budgetMonthlyCents).toBe(500);
  expect(saved.runtimeConfig).toEqual({ retained: true, heartbeat: { enabled: false, maxConcurrentRuns: 1, maxDailyRuns: 3, maxDailyCostCents: 500 } });
  expect(profile.buildAgent(input)).toEqual(original);
});

it("reports zero as no per-turn cap alongside real finite lifetime and rejects mismatched saved or selected settings", () => {
  const input = { selectedTurnTimeoutMs: 0, savedAgentTimeoutSec: 0, authoredLegacyTurnTimeoutMs: 120_000, attemptTimeoutMs: 300_000, observationBudgetMs: 270_000 };
  expect(chatNativeTimeoutEvidence(input)).toMatchObject({ effectiveNativeTurnTimeoutMs: 0,
    scenarioCellBudgetMs: 300_000, scenarioObservationBudgetMs: 270_000, playwrightBudgetMs: 390_000,
    launcherWatchdogMs: 690_000, activeRunCancellationWaitMs: 45_000, ownedProcessShutdownGraceMs: 45_000, ownedProcessKillGraceMs: 5_000 });
  for (const change of [{ selectedTurnTimeoutMs: 120_000 }, { savedAgentTimeoutSec: 120 }, { savedAgentTimeoutSec: undefined },
    { observationBudgetMs: Infinity }, { observationBudgetMs: 0 }, { observationBudgetMs: 300_000 }, { attemptTimeoutMs: 0 }, { attemptTimeoutMs: Infinity }, { authoredLegacyTurnTimeoutMs: 0 }])
    expect(() => chatNativeTimeoutEvidence({ ...input, ...change })).toThrow();
});
