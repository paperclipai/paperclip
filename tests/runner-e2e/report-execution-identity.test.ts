import { expect, it } from "vitest";
import { parseReportExecutionId } from "./report-catalog.js";
it.each([
  ["chat-features.runner-opencode.local.create-backlog", "create-backlog"],
  ["chat-features.runner-opencode.local.goals.create-goal-tree", "goals.create-goal-tree"],
  ["chat-features.runner-codex-subscription.local.tasks.create-backlog", "tasks.create-backlog"],
])("retains legacy and dotted chat identity %s", (id, caseId) => {
  expect(parseReportExecutionId(id)).toMatchObject({ suiteId: "chat-features", environmentId: "local", caseId });
});
it("preserves deployment target and ordinary nonchat identities", () => {
  expect(parseReportExecutionId("product-journeys.production.operator.local.task-properties")).toMatchObject({ suiteId: "product-journeys", targetId: "production", caseId: "task-properties" });
  expect(parseReportExecutionId("agent-chat.runner-opencode.local.conversation").caseId).toBe("conversation");
});
it.each(["../private", "goals/secret", "goals..create", "goals.create.extra", ".create", "goals.", "goals.create%2fsecret", "goals.create\\secret", "goals.CREATE", "goals.create?token=private"])("rejects malformed chat task %s", task => {
  expect(() => parseReportExecutionId(`chat-features.runner-opencode.local.${task}`)).toThrow();
});
it("does not enable dotted tasks for unrelated suites or permit excess path length", () => {
  expect(() => parseReportExecutionId("other-suite.runner-opencode.local.goals.create")).toThrow();
  expect(() => parseReportExecutionId(`chat-features.runner-opencode.local.goals.${"x".repeat(500)}`)).toThrow();
});

it("parses each supported private execution without changing its retained task identity", async () => {
 const { MANUAL_PRIVATE_EXECUTIONS } = await import("./manual-private-retention.js");
 for (const id of MANUAL_PRIVATE_EXECUTIONS) {
  const identity = parseReportExecutionId(id);
  expect(identity).toMatchObject({ suiteId: "chat-features", profileId: "runner-opencode", environmentId: "local", caseId: id.slice("chat-features.runner-opencode.local.".length), targetId: undefined });
 }
});
