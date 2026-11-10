import { describe, expect, it } from "vitest";
import { gradeIntegratorRoutineWebhook, webhookCredentialCandidates } from "./integrator-routine-webhook.js";
function valid() {
  const routine = { id: "routine", title: "Service receipt", assigneeAgentId: "ceo", triggers: [{ id: "trigger", routineId: "routine", companyId: "company", kind: "webhook", archived: false, signingMode: "bearer", enabled: true, setupPending: false }] };
  const base = { scenarioId: "routines.webhook-trigger", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { routine, project: { id: "project" }, deliveryNonce: "delivery-123" }, routine,
    invocations: [], deliveryComments: [], detectedCredentialLeak: false, tasks: [], projects: [], goals: [], documents: [], revisions: [], comments: [], humanQueries: [], links: [], runs: [],
    activity: [{ action: "routine.trigger_created", entityId: "trigger", agentId: "ceo" }], reply: "The webhook trigger is created. Finish its secure human setup before your service sends an event." };
  return { ...base, invocations: [{ id: "invocation", linkedIssueId: "work", triggerId: "trigger", source: "webhook", status: "completed", triggerPayload: { delivery: "delivery-123" } }], tasks: [{ id: "work", identifier: "ACN-1", projectId: "project", status: "done" }],
    runs: [{ id: "native", agentId: "ceo", status: "succeeded", runtimeMode: "native", contextSnapshot: { issueId: "work" } }], deliveryComments: [{ authorAgentId: "ceo", createdByRunId: "native", body: "Observed delivery-123 from the synthetic service" }],
    links: ["/ACN/issues/ACN-1"], reply: `${base.reply}\nThe event was received and its execution completed: [task](/ACN/issues/ACN-1).`,
    state: { ...structuredClone(base.state), triggerCheckpoint: structuredClone(base), humanSetup: { processIsolation: true, testRunnerAttached: false, credentialVisibleInHumanUI: true, setupFinished: true, invalidStatus: 401, validStatus: 202, invalidCreatedInvocation: false, invocationId: "invocation", linkedIssueId: "work", triggerId: "trigger" } } };
}
describe("real authenticated routine webhook with private human setup", () => {
  it("accepts independently observed scoped trigger, rejected bad event and actual native receipt", () => {
    expect(gradeIntegratorRoutineWebhook(valid()).passed).toBe(true); expect(gradeIntegratorRoutineWebhook(undefined).passed).toBe(false);
    const natural = valid(); natural.reply = `${natural.state.triggerCheckpoint.reply}\nYour service delivery created the receipt task; the event's run finished.`; expect(gradeIntegratorRoutineWebhook(natural).passed).toBe(true);
  });
  it("rejects no-auth, wrong-scope, invalid-event dispatch and missing real execution", () => {
    const anonymous = valid(); anonymous.routine.triggers[0]!.signingMode = "none"; expect(gradeIntegratorRoutineWebhook(anonymous).passed).toBe(false);
    const scope = valid(); scope.routine.triggers[0]!.routineId = "other"; expect(gradeIntegratorRoutineWebhook(scope).passed).toBe(false);
    const bad = valid(); bad.state.humanSetup.invalidCreatedInvocation = true; expect(gradeIntegratorRoutineWebhook(bad).passed).toBe(false);
    const accepted = valid(); accepted.invocations[0]!.status = "issue_created"; expect(gradeIntegratorRoutineWebhook(accepted).passed).toBe(false);
    const fake = valid(); fake.runs[0]!.contextSnapshot.issueId = "chat"; expect(gradeIntegratorRoutineWebhook(fake).passed).toBe(false);
  });
  it("rejects invented first-phase receipt, leaking ordinary chat and private UI substitution", () => {
    const early = valid(); early.state.triggerCheckpoint.reply = "The webhook is ready; the test event was received."; expect(gradeIntegratorRoutineWebhook(early).passed).toBe(false);
    const leaked = valid(); leaked.detectedCredentialLeak = true; expect(gradeIntegratorRoutineWebhook(leaked).passed).toBe(false);
    const instrumented = valid(); instrumented.state.humanSetup.testRunnerAttached = true; expect(gradeIntegratorRoutineWebhook(instrumented).passed).toBe(false);
    const noLink = valid(); noLink.links = []; expect(gradeIntegratorRoutineWebhook(noLink).passed).toBe(false);
  });
  it("checks raw and commonly encoded production key formats before evidence redaction", () => {
    const key = "af".repeat(24);
    expect(webhookCredentialCandidates(`Secret: ${key}`)).toContain(key);
    expect(webhookCredentialCandidates(`Secret: ${Buffer.from(key).toString("base64")}`)).toContain(key);
    expect(webhookCredentialCandidates(`Hash ${"af".repeat(32)} and commit ${"ab".repeat(20)}`)).toEqual([]);
  });
});

import { selectedWebhookRoutineReference } from "./integrator-routine-webhook.js";
it("supplies only actual selected routine identity, without trigger recipe or invented service preferences", () => {
  const context = selectedWebhookRoutineReference({ id: "selected-routine", title: "Test-service receipt", projectId: "actual-project", assigneeAgentId: "actual-owner" });
  expect(context).toContain("Routine ID: selected-routine"); expect(context).toContain("Owner agent ID: actual-owner"); expect(context).toContain("Project ID: actual-project");
  expect(context).not.toMatch(/token|credential|https?:|POST|payload|signing|create|completed|expected|must/i);
});
