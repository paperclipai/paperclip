import { expect, it } from "vitest";
import { gradeClaudeAccount, supportedClaudeSetupLink, completedClaudeSetupMatches } from "./runtime-claude-account.js";
function valid() { return { companyId: "company", leadId: "ceo", agents: [{ id: "morgan", name: "Morgan", companyId: "company", role: "engineer", title: "Frontend engineer", lifecycleState: "ready", status: "idle", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "claude" } }], tasks: [], links: [], humanQueries: ["Hire Morgan as a frontend engineer using Claude Code.", "The Anthropic account is connected now. Continue the same Morgan frontend engineer hire using Claude Code."], reply: "", activity: [{ id: "hire", entityId: "morgan", action: "agent.hire_created", actorType: "agent", actorId: "ceo", runId: "second" }], runs: [{ id: "first", agentId: "ceo", status: "succeeded" }, { id: "second", agentId: "ceo", status: "succeeded" }], state: { initialAnthropicAccounts: 0, actualInstalledClaude: true, supportedSetupVisible: true, waitingReply: "Morgan's frontend hire is waiting for an Anthropic account. Connect the account using this setup request before Claude can start.", noUsableMorganBeforeHuman: true, accountOwnerIsHuman: true, humanAccountConnected: true, continuationMessageBound: true, beforeMorganId: "morgan", actualAccountBinding: true, savedValidation: { probeStatus: "pass", agentId: "morgan" }, continuationReply: "Morgan is hired and the selected account is connected.", initialRunId: "first", continuationRunId: "second" } }; }
it("accepts preserved waiting hire followed by the actual human account and attributed continuation", () => { expect(gradeClaudeAccount(valid()).passed).toBe(true); const o = valid(); o.state.waitingReply = "I cannot finish the requested frontend hire until your Claude coding account is connected. Please use the supported setup flow."; o.state.continuationReply = "The frontend engineer has been added with the connected account."; expect(gradeClaudeAccount(o).passed).toBe(true); });
it("accepts a truthful future qualification instead of treating once-connected as current readiness", () => { const o = valid(); o.state.waitingReply = "Morgan is ready once the missing Anthropic account setup is complete; until then this hire is waiting for your connection."; expect(gradeClaudeAccount(o).passed).toBe(true); });
it("rejects ready-before-access, wrong human, lost identity, wrong phase and substituted harness", () => {
  for (const mutate of [(o: ReturnType<typeof valid>) => { o.state.waitingReply = "Morgan is ready for work; connect the missing Anthropic account later."; }, (o: ReturnType<typeof valid>) => { o.state.noUsableMorganBeforeHuman = false; }, (o: ReturnType<typeof valid>) => { o.state.accountOwnerIsHuman = false; }, (o: ReturnType<typeof valid>) => { o.state.beforeMorganId = "abandoned-original"; }, (o: ReturnType<typeof valid>) => { o.state.continuationMessageBound = false; }, (o: ReturnType<typeof valid>) => { o.agents[0]!.adapterConfig.acpxAgent = "codex"; }, (o: ReturnType<typeof valid>) => { o.state.actualAccountBinding = false; }]) { const o = valid(); mutate(o); expect(gradeClaudeAccount(o).passed).toBe(false); }
  expect(gradeClaudeAccount(undefined).passed).toBe(false);
});
it("accepts same-resource account setup links and rejects foreign company/provider routes", () => {
  for (const href of ["/ACORN/apps/connect?source=anthropic", "http://fixture.invalid/ACORN/apps/connect?provider=claude", "/ACORN/company/settings/connections"]) expect(supportedClaudeSetupLink(href, "http://fixture.invalid", "ACORN")).toBe(true);
  for (const href of ["https://foreign.invalid/ACORN/apps/connect?source=anthropic", "/BIRCH/apps/connect?source=anthropic", "/ACORN/apps/connect?source=openai"]) expect(supportedClaudeSetupLink(href, "http://fixture.invalid", "ACORN")).toBe(false);
});

it("requires real original setup-card reconciliation and exactly its declared automatic continuation", () => {
  const value = valid() as ReturnType<typeof valid> & { state: { setupRequestId?: string; setupRequestReconciled?: boolean; setupAutoWakeExpected?: boolean; setupAutoWakeBound?: boolean; autoMorganId?: string } };
  value.state.setupRequestId = "original-card";
  expect(gradeClaudeAccount(value).passed).toBe(false);
  value.state.setupRequestReconciled = true; expect(gradeClaudeAccount(value).passed).toBe(true);
  value.state.setupAutoWakeExpected = true; expect(gradeClaudeAccount(value).passed).toBe(false);
  value.runs.push({ id: "automatic", agentId: "ceo", status: "succeeded" }); value.state.setupAutoWakeBound = true; value.state.autoMorganId = "morgan";
  expect(gradeClaudeAccount(value).passed).toBe(true);
  value.state.setupAutoWakeBound = false; expect(gradeClaudeAccount(value).passed).toBe(false);
});

it("binds the resolved setup to the original actual human, source/native run and connected account DTO", () => {
  const value = { sourceId: "source", sourceRunId: "first", companyId: "company", humanId: "person", connectionId: "account", request: { kind: "connection_intent", issueId: "source", companyId: "company", sourceRunId: "first", addresseeUserId: "person", status: "accepted", resolvedByUserId: "person", resolvedByAgentId: null, payload: { serviceSlug: "anthropic" }, result: { outcome: "connected", connectionId: "account" } } } as unknown as Parameters<typeof completedClaudeSetupMatches>[0];
  expect(completedClaudeSetupMatches(value)).toBe(true);
  for (const patch of [{ status: "pending" }, { sourceRunId: "wrong-run" }, { resolvedByUserId: "wrong-human" }, { resolvedByAgentId: "impersonating-agent" }, { issueId: "foreign-source" }, { result: { outcome: "connected", connectionId: "wrong-account" } }]) expect(completedClaudeSetupMatches({ ...value, request: { ...value.request!, ...patch } as typeof value.request })).toBe(false);
});
