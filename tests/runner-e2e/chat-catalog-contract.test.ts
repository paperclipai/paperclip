import { describe, expect, it } from "vitest";
import { validateChatCatalogGrade } from "./chat-catalog-contract.js";
import { chatCatalogScenarios, chatCatalogInventoryDigest } from "./chat-catalog-inventory.js";
import { runnerMatrix } from "./catalog.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { chatCatalogCases } from "./chat-catalog-registry.js";

describe("catalog oracle contract", () => {
  it("accepts an independently checked result and rejects missing or contradictory evidence", () => {
    const checks = [{ id: "saved-owner", passed: true, detail: "Persisted assignee matches the requested agent" }];
    expect(validateChatCatalogGrade({ passed: true, checks }).passed).toBe(true);
    expect(validateChatCatalogGrade({ passed: false, checks: [{ ...checks[0]!, passed: false }] }).passed).toBe(false);
    for (const value of [{ passed: true, checks: [] }, { passed: true, checks: [{ ...checks[0]!, passed: false }] },
      { passed: true, checks: [...checks, ...checks] }]) expect(() => validateChatCatalogGrade(value)).toThrow();
  });
  it("discovers each concrete implementation explicitly with its exact query and bounds", () => {
    for (const implementation of chatCatalogCases) {
      const cells = runnerMatrix.filter(cell => cell.suite.id === "chat-features" && cell.task.id === implementation.scenarioId);
      expect(cells).toHaveLength(1);
      const cell = cells[0]!;
      expect(cell.task.buildPrompt("nonce")).toBe(chatCatalogScenarios.find(row => row.id === implementation.scenarioId)!.query);
      expect(cell.task.automaticRetryPolicy).toBe("single_attempt");
      expect(selectRunnerExecutions(parseRunnerSelectors(["--id", cell.id])).map(row => row.id)).toEqual([cell.id]);
      expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(row => row.id === cell.id)).toBe(false);
    }
  });
  it("keeps every frozen scenario in the denominator independently of executable readiness", () => {
    expect(chatCatalogScenarios).toHaveLength(244);
    expect(new Set(chatCatalogScenarios.map(row => row.feature)).size).toBe(35);
    expect(new Set(chatCatalogScenarios.flatMap(row => row.capabilities)).size).toBe(191);
    expect(chatCatalogInventoryDigest).toBe("0cf530c11449508e91b5ce664d9375fc8e76466fa908255a1af0ff55169d0220");
    for (const implementation of chatCatalogCases) expect(chatCatalogScenarios.some(row => row.id === implementation.scenarioId)).toBe(true);
  });
});
