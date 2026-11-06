import { expect, it } from "vitest";
import { gradeClaudeHire, claudeValidationReplyMatches } from "./runtime-claude-hiring.js";
import { validateClaudePrivateReceipt, matchesClaudeFixtureTarget } from "./runtime-claude-private.js";
function valid() {
  return { origin: "http://fixture.invalid", companyId: "company", leadId: "ceo", agents: [{ id: "morgan", name: "Morgan", companyId: "company", reportsTo: "ceo", role: "engineer", title: "Frontend engineer", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" }, lifecycleState: "ready" }], links: ["/ACORN/agents/morgan"], humanQueries: ["Hire Morgan"], reply: "", tasks: [], activity: [{ id: "hire", action: "agent.hire_created", entityId: "morgan", actorType: "agent", actorId: "ceo", runId: "source" }], runs: [{ id: "source", agentId: "ceo", status: "succeeded" }], state: { actualAccountBinding: true, savedTargetBound: true, selectedEnvironmentId: "environment", noApprovalPolicy: true, prerequisiteProbePassed: true, savedValidation: { agentId: "morgan", environmentId: "environment", probeStatus: "pass", probeCheckCodes: ["claude_hello_passed"] }, canonicalReply: "Morgan is created as your frontend engineer. The account is connected and runtime validation passed; the saved profile is linked here." } };
}
it("accepts a real native Claude hire and natural distinction between saved profile and validation", () => {
  expect(gradeClaudeHire(valid()).passed).toBe(true); const o = valid(); o.state.canonicalReply = "I've added Morgan to the team with the frontend role and reporting line saved. The selected account and computer passed the startup test."; expect(gradeClaudeHire(o).passed).toBe(true);
});
it("rejects wrong harness/account/target, duplicate hire, wrong actor/run and missing profile link", () => {
  for (const mutate of [(o: ReturnType<typeof valid>) => { o.agents[0]!.adapterConfig.acpxAgent = "codex"; }, (o: ReturnType<typeof valid>) => { o.agents.push({ ...o.agents[0]!, id: "duplicate" }); }, (o: ReturnType<typeof valid>) => { o.state.actualAccountBinding = false; }, (o: ReturnType<typeof valid>) => { o.state.savedTargetBound = false; }, (o: ReturnType<typeof valid>) => { o.activity[0]!.runId = "other-run"; }, (o: ReturnType<typeof valid>) => { o.activity[0]!.actorId = "other"; }, (o: ReturnType<typeof valid>) => { o.links = []; }]) { const o = valid(); mutate(o); expect(gradeClaudeHire(o).passed).toBe(false); }
  expect(gradeClaudeHire(undefined).passed).toBe(false);
});
it("retains observed authentication failure and rejects falsely calling an unusable profile ready", () => {
  const failure = { probeStatus: "fail" as const, probeCheckCodes: ["claude_auth_missing"] };
  expect(claudeValidationReplyMatches("Morgan was created, but the startup test failed because the account needs authentication. Reconnect the account before assigning work.", failure)).toBe(true);
  expect(claudeValidationReplyMatches("Morgan is ready. Authentication validation failed, so reconnect later.", failure)).toBe(false);
  expect(claudeValidationReplyMatches("Morgan could not start; check the model.", failure)).toBe(false);
});
it("allows only closed scoped ID/check-code receipts from the standalone private worker", () => {
  const id = "11111111-1111-4111-8111-111111111111", expected = { operation: "prepare-account" as const, companyId: id, environmentId: id };
  const receipt = { ...expected, processIsolation: true, testRunnerAttached: false, apiStepRecorder: false, connectionId: id, grantId: id, probeStatus: "pass", probeCheckCodes: ["claude_hello_passed"] };
  expect(validateClaudePrivateReceipt(receipt, expected)).toEqual(receipt);
  for (const patch of [{ credential: "synthetic-private-key" }, { testRunnerAttached: true }, { companyId: "foreign" }, { probeCheckCodes: ["raw diagnostic with a credential"] }]) expect(() => validateClaudePrivateReceipt({ ...receipt, ...patch }, expected)).toThrow("closed");
});

it("binds real instance-scoped Environment DTOs through exact fixture and authorized public inventory", () => {
  const detail = { id: "environment", driver: "local" as const, status: "active" as const };
  const input = { company: { id: "company" }, expectedCompanyId: "company", fixtureEnvironmentId: "environment", detail, listed: [{ ...detail }] };
  expect(matchesClaudeFixtureTarget(input)).toBe(true); // There is deliberately no invented companyId on the DTO.
  expect(matchesClaudeFixtureTarget({ ...input, company: { id: "foreign" } })).toBe(false);
  expect(matchesClaudeFixtureTarget({ ...input, listed: [] })).toBe(false);
  expect(matchesClaudeFixtureTarget({ ...input, fixtureEnvironmentId: "another-environment" })).toBe(false);
  expect(matchesClaudeFixtureTarget({ ...input, listed: [{ ...detail, status: "archived" }] })).toBe(false);
});
