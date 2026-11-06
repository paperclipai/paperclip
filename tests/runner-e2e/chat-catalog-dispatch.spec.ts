import { expect, test } from "@playwright/test";
import { findChatCatalogCase, loadChatCatalogImplementation } from "./chat-catalog-registry.js";
import { parseReportExecutionId } from "./report-catalog.js";

test("chat catalog loads its selected source module in the actual Playwright worker", async () => {
  const descriptor = findChatCatalogCase("goals.create-goal-tree")!;
  const implementation = await loadChatCatalogImplementation(descriptor);
  expect(implementation.scenarioId).toBe(descriptor.scenarioId);
  for (const method of [implementation.setup, implementation.observe, implementation.grade, implementation.verifyResult]) expect(typeof method).toBe("function");
  // Import-only regression: no fixture, database, browser, provider or user query is invoked.
});

test("chat catalog report preserves its canonical dotted case ID and rejects forged paths", () => {
  const prefix = "chat-features.runner-codex-subscription.local.";
  expect(parseReportExecutionId(`${prefix}goals.create-goal-tree`)).toMatchObject({ suiteId: "chat-features", caseId: "goals.create-goal-tree" });
  for (const suffix of ["../private", "goals/secret", "goals..create", "goals.create.extra"]) expect(() => parseReportExecutionId(prefix + suffix)).toThrow();
  expect(() => parseReportExecutionId("other-suite.runner.local.goals.create")).toThrow();
});
