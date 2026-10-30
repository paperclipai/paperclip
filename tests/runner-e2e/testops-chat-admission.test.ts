import { expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { authorizeShippedChat } from "./testops-chat-admission.js";

const id = "chat-features.runner-opencode.local.create-backlog";
function fixture() {
  const env: NodeJS.ProcessEnv = { PAPERCLIP_TESTOPS_CHAT_MAIN_ADMISSION: "v1", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "paperclipai/paperclip", GITHUB_REF: "refs/heads/master", GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/chat-feature-testops.yml@refs/heads/master",
    GITHUB_JOB: "chat", GITHUB_SHA: "a".repeat(40), TARGET_SHA: "a".repeat(40), TESTOPS_ADMITTED_SHA: "a".repeat(40), GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_ACTOR_ID: "123", TESTOPS_TRIGGERING_ACTOR_ID: "123", TESTOPS_ALLOWED_ACTOR_IDS: "[123]", MANUAL_PRIVATE_IDS: JSON.stringify([id]), SELECTED_EXECUTION_ID: id };
  const event = { ref: "refs/heads/master", sender: { id: 123 }, repository: { full_name: "paperclipai/paperclip", private: false, default_branch: "master" }, inputs: { ALLURE_JOB_RUN_ID: "789", operation: "evaluate" } as Record<string, string> };
  const selected = runnerMatrix.find(row => row.id === id)!;
  return { env, event, selected };
}
it("binds the actual shipped selection to immutable main admission without candidate approval variables", () => {
  const f = fixture(); const result = authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64));
  expect(result).toMatchObject({ authority: "paperclip.shipped-chat-testops/v1", private: true, runId: "12345", attempt: "1", workflowSha: f.env.GITHUB_SHA, targetSha: f.env.GITHUB_SHA, executionIds: [id] });
  expect(result.authoritySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(authorizeShippedChat({ ...f.env, LATEST_MASTER_SHA: "c".repeat(40), GITHUB_JOB: "report" }, f.event, f.selected, "b".repeat(64)).authoritySha256).toBe(result.authoritySha256);
});
it.each([
  ["unknown mode", { PAPERCLIP_TESTOPS_CHAT_MAIN_ADMISSION: "unknown" }],
  ["untrusted repo", { GITHUB_REPOSITORY: "foreign/repo" }],
  ["nondefault ref", { GITHUB_REF: "refs/heads/feature" }],
  ["wrong workflow caller", { GITHUB_WORKFLOW_REF: "paperclipai/paperclip/.github/workflows/runner-full-stack-e2e.yml@refs/heads/master" }],
  ["source substitution", { TARGET_SHA: "c".repeat(40) }],
  ["admitted source mismatch", { TESTOPS_ADMITTED_SHA: "c".repeat(40) }],
  ["replay", { GITHUB_RUN_ATTEMPT: "2" }],
  ["unlisted actor", { TESTOPS_ALLOWED_ACTOR_IDS: "[456]" }],
  ["untrusted job", { GITHUB_JOB: "build" }],
  ["foreign selector", { SELECTED_EXECUTION_ID: "other" }],
])("rejects %s", (_name, patch) => { const f = fixture(); expect(() => authorizeShippedChat({ ...f.env, ...patch }, f.event, f.selected, "b".repeat(64))).toThrow(); });
it.each(["target_branch", "profile", "model", "retries", "timeout"])("rejects the undeclared %s input", field => {
  const f = fixture(); f.event.inputs[field] = "override"; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow();
});
it("rejects metadata bootstrap as an evaluation admission", () => { const f = fixture(); f.event.inputs.operation = "bootstrap"; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow(); });
it("rejects forged event sender and foreign event source", () => {
  const f = fixture(); f.event.sender.id = 456; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow();
  f.event.sender.id = 123; f.event.repository.full_name = "foreign/repo"; expect(() => authorizeShippedChat(f.env, f.event, f.selected, "b".repeat(64))).toThrow();
});
it.each(["model", "provider", "work", "clock", "retry", "budget"])("rejects changed selected %s", field => {
  const f = fixture(); const selected = { ...f.selected, profile: { ...f.selected.profile }, task: { ...f.selected.task }, suite: { ...f.selected.suite, definitionMetadata: { ...f.selected.suite.definitionMetadata } } };
  if (field === "model") selected.profile.model = "other/model";
  if (field === "provider") selected.profile.provider = "codex";
  if (field === "work") selected.task.expectedRunCount = 2;
  if (field === "clock") selected.task.turnTimeoutMs = 121000;
  if (field === "retry") selected.task.automaticRetryPolicy = undefined;
  if (field === "budget") selected.suite.definitionMetadata.companyAndAgentBudgetCents = 1000;
  expect(() => authorizeShippedChat(f.env, f.event, selected, "b".repeat(64))).toThrow();
});
