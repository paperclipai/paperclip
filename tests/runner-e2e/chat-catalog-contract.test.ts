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
    // agent-chat.chat-disabled retargeted to the Conference Room gate (Agent Chat is always on since #19360);
    // agents.restore-instructions retargeted to no saved history (instruction saves keep none since #14420).
    // access.manage-membership retargeted to read-and-route; activity.routine-audit builds real same-morning history.
    // gateways-profiles.create-gateway and rotate-token: agents keep delegated gateway/token authority and never receive token values.
    expect(chatCatalogInventoryDigest).toBe("48fdd6e646117851eee6e309c914fadbc80f2dd7ac4f90eb1538de70e18c4c6c");
    for (const implementation of chatCatalogCases) expect(chatCatalogScenarios.some(row => row.id === implementation.scenarioId)).toBe(true);
  });
});
