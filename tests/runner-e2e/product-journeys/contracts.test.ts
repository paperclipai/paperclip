import { describe, it, expect, vi } from "vitest";
import { FixtureRegistry } from "../fixture-registry.js";
import { parseTargetConfig, preparationPreview, productJourneys } from "./catalog.js";
import { journeyFixtures } from "./fixtures.js";
import { taskProperties } from "./task-properties.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import { assertPublicCampaign } from "../history-publish.js";
import { validateJourneyCollection } from "./collection.js";
import { summarizeExecutionBilling, aggregateCampaignBilling } from "../billing.js";
import { discoverReportCatalog } from "../report-catalog.js";
import { isIncompleteFirstTaskResult, renderCaseOutcome } from "../case-outcome.js";
import type { RunnerE2EResult } from "../types.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";
import { createConnectionProof } from "../connection-evidence.js";
import { retainOnboardingArtifact } from "./artifact-evidence.js";
import type { OnboardingConnectEvidence } from "./onboarding-connect.js";
vi.mock("@playwright/test", () => ({
  expect: Object.assign(
    (locator: { textContent(): Promise<string> }) => ({ async toContainText(value: string) { expect(await locator.textContent()).toContain(value); } }),
    { poll: (read: () => Promise<unknown>) => ({ async toBe(value: unknown) { expect(await read()).toBe(value); } }) },
  ),
}));
const local = { version: 1, id: "local-qa", mode: "managed-self-hosted", journeys: ["task-properties"], executionEnvironment: "local", baseline: { features: {}, connections: [] }, limits: { durationMs: 10000, modelBudgetCents: 0, maxRuns: 0 } };
function preparedContext(startingState: JourneyContext["startingState"] = "recipe") {
  const api = { origin: "https://qa.example.test", post: vi.fn(async () => ({ id: "task-1", identifier: "QA-1" })) };
  const context = { capabilities: ["company", "board-user", "task-write"], company: { id: "company-1", issuePrefix: "QA" }, user: { id: "user-1", name: "QA" }, api, startingState } as unknown as JourneyContext;
  return { context, api };
}
function result(): RunnerE2EResult {
  return { schema: "paperclip.runner-e2e.result/v2", suiteId: "product-journeys", suiteDefinitionHash: "test", executionId: "product-journeys.local-qa.local.task-properties", profileId: "local-qa", environmentId: "local", caseId: "task-properties", provider: null, model: null, runtimeMode: "none", status: "passed", cleanup: "passed", attempt: 1, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", durationMs: 1000,
    productJourney: { outcome: "passed", startingState: "recipe", phases: [{phase: "journey", outcome: "passed"}], checks: [{id:"assignment-persisted", passed:true},{id:"no-agent-work",passed:true}], privacy: "private", resourceDisposition: "released", deployment: { kind: "self-hosted", targetId: "local-qa", origin: "http://127.0.0.1:3100", commit: "a".repeat(40), cloudRelease: null, runtimeImage: null, configurationHash: "test" } } };
}
function connectReceipt(): OnboardingConnectEvidence {
  return {
    version: 1, checkpoint: "hire",
    validation: { state: "json", httpStatus: 200, requestedAdapter: "paperclip_runner", adapter: "paperclip_runner", outcome: "fail", serverCode: null, checks: [{ code: "adapter_auth_missing", level: "error" }], truncatedChecks: false },
    hire: { state: "json", httpStatus: 422, requestedAdapter: null, adapter: null, outcome: null, serverCode: "agent_runner_unavailable", checks: [], truncatedChecks: false },
  };
}
describe("deployment journey contracts", () => {
  it("accepts historical results without Connect diagnostics and optional closed receipts", () => {
    const retained = result();
    retained.caseId = "cloud-onboarding";
    retained.status = "failed";
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    expect(renderCaseOutcome(retained, true, [])).not.toContain("Onboarding Connect diagnostics");
    retained.productJourney!.onboardingConnect = connectReceipt();
    expect(() => validateRetainedRunnerResult(JSON.parse(JSON.stringify(retained)))).not.toThrow();
    retained.productJourney!.onboardingConnect.validation = { state: "pending", httpStatus: 200, requestedAdapter: "codex_local", adapter: null, outcome: null, serverCode: null, checks: [], truncatedChecks: false };
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
  });
  it.each([
    ["request headers", () => ({ ...connectReceipt(), requestHeaders: { authorization: "must-not-retain" } })],
    ["response bodies", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, body: "must-not-retain" } })],
    ["check messages", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, checks: [{ code: "adapter_auth_missing", level: "error", message: "must-not-retain" }] } })],
    ["unknown server codes", () => ({ ...connectReceipt(), hire: { ...connectReceipt().hire, serverCode: "raw-provider-error" } })],
    ["unknown check codes", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, checks: [{ code: "raw-provider-error", level: "error" }] } })],
    ["unknown adapters", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, adapter: "raw-provider-name" } })],
    ["unknown requested adapters", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, requestedAdapter: "raw-provider-name" } })],
    ["unknown outcomes", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, outcome: "raw-provider-message" } })],
    ["unknown response states", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, state: "raw-provider-message" } })],
    ["unknown check levels", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, checks: [{ code: "adapter_auth_missing", level: "fatal" }] } })],
    ["oversized check arrays", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, checks: Array.from({ length: 33 }, () => ({ code: "adapter_auth_missing", level: "error" })) } })],
    ["invalid HTTP statuses", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, httpStatus: 600 } })],
    ["non-boolean truncation", () => ({ ...connectReceipt(), validation: { ...connectReceipt().validation, truncatedChecks: "true" } })],
    ["missing response fields", () => ({ ...connectReceipt(), hire: { state: "missing" } })],
    ["unsupported receipt versions", () => ({ ...connectReceipt(), version: 2 })],
    ["unknown checkpoints", () => ({ ...connectReceipt(), checkpoint: "raw-browser-text" })],
  ] as const)("rejects Connect receipts containing %s", (_label, makeReceipt) => {
    const retained = result();
    retained.productJourney!.onboardingConnect = makeReceipt() as OnboardingConnectEvidence;
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.onboardingConnect");
  });
  it("renders only validated Connect fields and marks missing or truncated evidence", () => {
    const retained = result();
    retained.productJourney!.onboardingConnect = connectReceipt();
    const output = renderCaseOutcome(retained, true, []);
    for (const text of ["Onboarding Connect diagnostics", "Last checkpoint", "Native validation", "Agent hire", "HTTP status", "Test endpoint adapter", "Returned adapter", "200", "422", "paperclip_runner", "adapter_auth_missing", "agent_runner_unavailable", "error", "Unavailable"]) expect(output).toContain(text);
    retained.productJourney!.onboardingConnect.validation.truncatedChecks = true;
    expect(renderCaseOutcome(retained, true, [])).toContain("Only the first 32 validation checks were retained");
    Object.assign(retained.productJourney!.onboardingConnect.validation, { body: "<script>must-not-render</script>" });
    const invalid = renderCaseOutcome(retained, false, []);
    expect(invalid).toContain("Onboarding Connect diagnostics unavailable: invalid receipt");
    expect(invalid).not.toContain("must-not-render");
    expect(invalid).not.toContain("adapter_auth_missing");
  });
  it("validates optional historical artifact evidence without trusting extra fields or a different run", () => {
    const retained = result();
    retained.caseId = "cloud-onboarding";
    retained.status = "failed";
    expect(() => validateRetainedRunnerResult(retained)).not.toThrow();
    const proof = createConnectionProof();
    retained.productJourney!.artifact = retainOnboardingArtifact({ id: "artifact", originatingRunId: "artifact-run", bytes: Buffer.from(JSON.stringify(proof.expected)), proof });
    retained.runIds = ["artifact-run"];
    expect(() => validateRetainedRunnerResult(JSON.parse(JSON.stringify(retained)))).not.toThrow();
    retained.runIds = ["other-run"];
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.artifact");
    retained.runIds = ["artifact-run"];
    Object.assign(retained.productJourney!.artifact, { requestHeaders: {} });
    expect(() => validateRetainedRunnerResult(retained)).toThrow("result.productJourney.artifact");
  });
  it("resolves only requested prerequisites, once, and unwinds on failure", async () => {
    const calls: string[] = [];
    const registry = new FixtureRegistry().register({id:"a", async setup(){calls.push("a"); return 1;}, async teardown(){calls.push("-a");}})
      .register({id:"b",dependencies:["a"],async setup(){calls.push("b");throw new Error("setup");}})
      .register({id:"unselected",async setup(){throw new Error("unselected");}});
    await expect(registry.setupAll(["b"])).rejects.toThrow("setup");
    expect(calls).toEqual(["a","b","-a"]);
  });
  it("reuses verified onboarding without claiming recipe setup is onboarding coverage", async () => {
    const ready = { capabilities:["company","board-user","task-write"], startingState:"onboarding" } as JourneyContext;
    const prepare = vi.fn(async () => ({...ready, startingState:"recipe"}));
    const fixtures = journeyFixtures({prepare} as unknown as TargetSession);
    fixtures.provide(ready);
    expect(await fixtures.resolve(["company","board-user"])).toBe(ready);
    expect(prepare).not.toHaveBeenCalled();
    const independent = journeyFixtures({prepare} as unknown as TargetSession);
    expect((await independent.resolve(["task-write"])).startingState).toBe("recipe");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it.each(["recipe", "onboarding"] as const)("prepares one owned backlog task from %s context before the journey", async startingState => {
    const { context, api } = preparedContext(startingState);
    const calls: string[] = [];
    api.post.mockImplementation(async () => { calls.push("create"); return { id: "task-1", identifier: "QA-1" }; });
    const prepare = vi.fn(async () => { calls.push("prepare"); return context; });
    const own = vi.fn(async (resource: { id?: string }) => { calls.push(resource.id ? "receipt" : "intent"); });
    const fixtures = journeyFixtures({ prepare, own } as unknown as TargetSession, "campaign-1");
    if (startingState === "onboarding") fixtures.provide(context);
    const required = productJourneys.find(journey => journey.id === "task-properties")!.requires;
    for (const resolved of await Promise.all([fixtures.resolve(required), fixtures.resolve(required)])) expect(resolved).toBe(context);
    expect(calls).toEqual([...(startingState === "recipe" ? ["prepare"] : []), "intent", "create", "receipt"]);
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/companies/company-1/issues", { title: "Journey QA campaign-1", description: "Disposable task-property verification", status: "backlog" });
    expect(own.mock.calls).toEqual([[{ kind: "issue", name: "Journey QA campaign-1" }], [{ kind: "issue", name: "Journey QA campaign-1", id: "task-1" }]]);
    expect(context.fixtures?.backlogTask).toEqual({ id: "task-1", identifier: "QA-1", title: "Journey QA campaign-1" });
    expect(context.startingState).toBe(startingState);
    expect(prepare).toHaveBeenCalledTimes(startingState === "recipe" ? 1 : 0);
  });
  it("requires a campaign ID only when a run-owned task is requested", async () => {
    const { context, api } = preparedContext();
    const prepare = vi.fn(async () => context);
    const own = vi.fn();
    const fixtures = journeyFixtures({ prepare, own } as unknown as TargetSession);
    await expect(fixtures.resolve(["backlog-task"])).rejects.toMatchObject({ outcome: "blocked", code: "campaign_id_required_for_backlog_task" });
    expect(prepare).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
    expect(await fixtures.resolve(["company"])).toBe(context);
  });
  it.each(["intent", "receipt"])("does not redispatch task creation after an uncertain %s failure", async failure => {
    const { context, api } = preparedContext();
    const own = vi.fn(async (resource: { id?: string }) => { if (Boolean(resource.id) === (failure === "receipt")) throw Error("ownership write failed"); });
    const fixtures = journeyFixtures({ prepare: async () => context, own } as unknown as TargetSession, "campaign-1");
    await expect(fixtures.resolve(["backlog-task"])).rejects.toThrow("ownership write failed");
    await expect(fixtures.resolve(["backlog-task"])).rejects.toThrow("ownership write failed");
    expect(api.post).toHaveBeenCalledTimes(failure === "receipt" ? 1 : 0);
    expect(own).toHaveBeenCalledTimes(failure === "receipt" ? 2 : 1);
  });
  it("uses the supplied task for UI assignment without creating another task", async () => {
    const { context, api } = preparedContext();
    const session = { prepare: async () => context, own: vi.fn(async () => {}) } as unknown as TargetSession;
    const fixtures = journeyFixtures(session, "campaign-1");
    await fixtures.resolve(["backlog-task"]);
    api.post.mockImplementation(async () => { throw Error("task creation inside measured story"); });
    let assigned = false;
    const locator = { filter: vi.fn(), first: vi.fn(), locator: vi.fn(), getByRole: vi.fn(), click: vi.fn(), isVisible: vi.fn(async () => false), textContent: vi.fn(async () => assigned ? "You" : "Unassigned") };
    for (const method of [locator.filter, locator.first, locator.locator, locator.getByRole]) method.mockReturnValue(locator);
    const assign = { click: vi.fn(async () => { assigned = true; }) };
    const page = { goto: vi.fn(), reload: vi.fn(), locator: vi.fn(() => locator), getByRole: vi.fn((_role: string, options?: { name?: unknown }) => options?.name === "Assign to me" ? assign : locator) };
    const get = vi.fn(async (route: string) => route.endsWith("/runs") ? [] : { assigneeUserId: assigned ? context.user.id : null, assigneeAgentId: null, status: "backlog" });
    Object.assign(context.api, { get });
    context.page = page as unknown as JourneyContext["page"];
    const evidence = { checks: [] } as unknown as JourneyEvidence;
    await taskProperties(context, session, "campaign-1", evidence);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(session.own).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenCalledExactlyOnceWith("https://qa.example.test/QA/issues");
    expect(locator.filter).toHaveBeenCalledWith({ hasText: "Journey QA campaign-1" });
    expect(assign.click).toHaveBeenCalledOnce();
    expect(page.reload).toHaveBeenCalledOnce();
    expect(get.mock.calls.map(([route]) => route)).toEqual(["/api/issues/task-1", "/api/issues/task-1", "/api/issues/task-1/runs"]);
    expect(evidence.checks).toEqual([{ id: "assignment-persisted", passed: true }, { id: "no-agent-work", passed: true }]);
  });
  it("blocks a story without the prepared task before using browser or API", async () => {
    const { context, api } = preparedContext();
    const own = vi.fn();
    await expect(taskProperties(context, { own } as unknown as TargetSession, "campaign-1", { checks: [] } as unknown as JourneyEvidence)).rejects.toMatchObject({ outcome: "blocked", code: "missing_prepared_backlog_task" });
    expect(api.post).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
  });
  it("rejects missing capabilities and cycles", async () => {
    const { context, api } = preparedContext();
    context.capabilities = [];
    const fixtures = journeyFixtures({ prepare: async () => context } as unknown as TargetSession, "campaign-1");
    await expect(fixtures.resolve(["backlog-task"])).rejects.toMatchObject({outcome:"unsupported"});
    expect(api.post).not.toHaveBeenCalled();
    const graph = new FixtureRegistry().register({id:"a",dependencies:["b"],setup:async()=>null}).register({id:"b",dependencies:["a"],setup:async()=>null});
    await expect(graph.setupAll(["a"])).rejects.toThrow("cycle");
  });
  it("requires explicit paid limits and compatible deployment selections", () => {
    expect(preparationPreview(parseTargetConfig(local)).modelProfileId).toBeNull();
    const fresh = {...local,mode:"new-cloud",adapterModule:"/private/provider.mjs",journeys:["cloud-onboarding","task-properties"]};
    expect(()=>parseTargetConfig(fresh)).toThrow("paid_journey_requires_limits");
    expect(()=>parseTargetConfig({...fresh,limits:{...local.limits,modelBudgetCents:1000,maxRuns:1}})).not.toThrow();
    expect(()=>parseTargetConfig({...local,executionEnvironment:"daytona"})).toThrow("unsupported");
    expect(()=>parseTargetConfig({...local,journeys:["cloud-onboarding"]})).toThrow("onboarding_requires");
    expect(()=>parseTargetConfig({...local,apiKey:"secret"})).toThrow("fields");
  });
  it("preview never loads or emits private adapter configuration", () => {
    const config = parseTargetConfig({...local,mode:"existing-cloud",adapterModule:"/not-installed.mjs",adapterConfig:{operatorSecret:"never-print"}});
    expect(JSON.stringify(preparationPreview(config))).not.toContain("never-print");
  });
  it("counts shared setup once and rejects raw data in collection receipts", () => {
    const onboarding = result(); onboarding.caseId="cloud-onboarding"; onboarding.runtimeMode="native";
    onboarding.runIds=["run-1"]; onboarding.usage={runs:[{runId:"run-1",usage:{costUsd:0.5,inputTokens:10,outputTokens:10}}]};
    onboarding.productJourney!.operations={campaignId:"campaign",attemptId:"attempt",modelCostUsd:0.7,setupCostUsd:0.2,requestCount:2,feedback:{collection:"complete",complaints:0,suggestions:1},traceIds:[]};
    expect(aggregateCampaignBilling([onboarding,result()]).observedAndEstimatedCostUsd).toBeCloseTo(0.7);
    onboarding.usage={runs:[{runId:"run-1",usage:{costUsdExact:"0.5",costStatus:"estimated",inputTokens:10,outputTokens:10}}]};
    expect(aggregateCampaignBilling([onboarding,result()]).observedAndEstimatedCostUsd).toBeCloseTo(0.7);
    expect(()=>validateJourneyCollection({journeyId:"cloud-onboarding",runIds:["run"],usage:{runs:[{runId:"run",usage:{apiKey:"not-retainable"} as any}]}})).toThrow("invalid_collection_receipt");
    onboarding.productJourney!.operations.modelCostUsd=null;
    expect(aggregateCampaignBilling([onboarding,result()]).observedAndEstimatedCostUsd).toBeNull();
  });
  it("requires real pass evidence and forbids model work in browser-only passes", () => {
    expect(()=>validateRetainedRunnerResult(result())).not.toThrow();
    const missing = result(); missing.productJourney!.checks=[];
    expect(()=>validateRetainedRunnerResult(missing)).toThrow();
    const paid = result(); paid.runIds=["unexpected"];
    expect(()=>validateRetainedRunnerResult(paid)).toThrow();
  });
  it("keeps browser-only reporting free of invented model calls and rejects public publication", () => {
    const value=result();
    expect(summarizeExecutionBilling(value)).toMatchObject({llm:{runCount:0,reportedCostUsd:0},runtime:{agentRunDurationMs:0}});
    expect(discoverReportCatalog({expected:[value.executionId],results:[value],catalog:[]})[0]?.profile).toMatchObject({provider:null,model:null,generation:"none"});
    expect(()=>assertPublicCampaign({results:[value]})).toThrow("Private");
    value.status="failed"; value.productJourney!.outcome="blocked";
    value.productJourney!.checks=[];
    expect(summarizeExecutionBilling(value).llm.runCount).toBe(0);
    expect(isIncompleteFirstTaskResult(value)).toBe(true);
    value.productJourney!.outcome="failed";
    expect(isIncompleteFirstTaskResult(value)).toBe(false);
  });
  it("renders deployment provenance and distinct unsupported outcomes without exposing unknown fields", () => {
    const value=result(); value.status="failed";
    value.productJourney!.outcome="unsupported";
    value.productJourney!.campaignId="campaign-1"; value.productJourney!.attemptId="attempt-1";
    Object.assign(value.productJourney!.deployment!, { cloudRelease:"release-1", runtimeImage:"image-1", configurationHash:"config-1", effectiveFeatures:{runner:true}, executionEnvironment:{id:"environment-1",driver:"sandbox",status:"active"} });
    Object.assign(value.productJourney!, { credential:"must-not-render" });
    const output=renderCaseOutcome(value,true,[]);
    for (const text of ["unsupported", "Deployment and setup evidence", "campaign-1", "attempt-1", "release-1", "image-1", "config-1", "starting state: recipe", "Effective features", "environment-1", "sandbox"]) expect(output).toContain(text);
    expect(output).not.toContain("must-not-render");
    value.productJourney!.deployment!.runtimeImage="<script>alert(1)</script>";
    expect(renderCaseOutcome(value,true,[])).toContain("&lt;script&gt;");
    value.productJourney!.deployment!.effectiveFeatures={runner:"not-a-boolean"} as any;
    expect(()=>validateRetainedRunnerResult(value)).toThrow();
  });
});
