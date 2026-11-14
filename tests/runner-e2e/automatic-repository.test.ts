import { expect, it } from "vitest";
import { automaticRepositoryApiState, automaticRepositoryStopReason, gradeAutomaticRepository, type AutomaticRepositoryObservation } from "./automatic-repository.js";

const sha = "a".repeat(40);
const reference = "c".repeat(64);
const valid: AutomaticRepositoryObservation = { expectedModel: "gpt-6.1-sol", expectedProvider: "codex",
  actualProviders: [{ model: "gpt-6.1-sol", kind: "codex" }, { model: "gpt-6.1-sol", kind: "codex" }], reference, issueDone: true, runCount: 2,
  successfulCommittedRuns: 2, sourceContinuation: "same_agent", successorSource: "native_status_decision", workspaceIds: ["workspace", "workspace"],
  readyRepository: true, savedContext: `${reference}\n`, firstSavedContext: `${reference}\n`, firstContextAttributed: true,
  firstContextObservedAt: 1000, successorStartedAt: 2000, predecessorFinishedAt: 1900, predecessorRetagged: false,
  continuationReceipt: { intentId: "11111111-1111-4111-8111-111111111111", dispatchId: "22222222-2222-4222-8222-222222222222" },
  actualReadme: "Hello World!\n", actualCommit: sha,
  downloaded: { reference, readme: "Hello World!\n", commit: sha }, downloadVerified: true,
  visibleDelivery: true, pendingInteractions: 0, monitorScheduled: false };

it("accepts independent checkout, retained context, and accessible registered output", () => {
  expect(gradeAutomaticRepository(valid).every(check => check.passed)).toBe(true);
});

it("reports a committed setup blocker immediately instead of waiting out the attempt deadline", () => {
  expect(automaticRepositoryStopReason({ status: "blocked" }, [{ status: "succeeded" }])).toContain("stopped in blocked");
  expect(automaticRepositoryStopReason({ status: "done" }, [{ status: "succeeded" }])).toContain("without its automatic successor");
});

it("keeps waiting for an ordinary queued successor and accepts two completed admissions", () => {
  expect(automaticRepositoryStopReason({ status: "in_progress" }, [{ status: "succeeded" }])).toBeUndefined();
  expect(automaticRepositoryStopReason({ status: "in_progress" }, [{ status: "succeeded" }, { status: "queued" }])).toBeUndefined();
  expect(automaticRepositoryStopReason({ status: "done" }, [{ status: "succeeded" }, { status: "succeeded" }])).toBeUndefined();
});

it("rejects unexpected result fields rather than trusting a model's extra claims", () => {
  const extra = { ...valid, downloaded: { ...valid.downloaded, claimedPass: true } };
  expect(gradeAutomaticRepository(extra).find(check => check.id === "independent-result")?.passed).toBe(false);
});

it.each<Partial<AutomaticRepositoryObservation>>([
  { runCount: 1 }, { successfulCommittedRuns: 1 }, { sourceContinuation: "monitor" }, { successorSource: "issue.comment" },
  { workspaceIds: ["old", "new"] }, { savedContext: null }, { firstSavedContext: null }, { firstContextAttributed: false },
  { firstSavedContext: `${"d".repeat(64)}\n` }, { firstSavedContext: "REFERENCE-fresh\n" },
  { firstContextObservedAt: null }, { firstContextObservedAt: 2000 }, { firstContextObservedAt: 3000 }, { successorStartedAt: null },
  { actualProviders: [] }, { actualProviders: [{ model: "gpt-6.1-sol", kind: "codex" }] },
  { actualProviders: [{ model: "gpt-5.6-sol", kind: "codex" }, valid.actualProviders[1]!] },
  { actualProviders: [valid.actualProviders[0]!, { model: "gpt-6.1-sol", kind: "acpx:claude" }] },
  { readyRepository: false }, { downloaded: null }, { predecessorFinishedAt: null }, { predecessorFinishedAt: 2001 },
  { predecessorRetagged: true }, { continuationReceipt: null },
  { continuationReceipt: { ...valid.continuationReceipt!, dispatchId: valid.continuationReceipt!.intentId } },
  { continuationReceipt: { ...valid.continuationReceipt!, intentId: "unverified" } },
  { downloaded: { ...valid.downloaded, reference: "REFERENCE-stale" } },
  { downloaded: { ...valid.downloaded, readme: "I inspected it and all checks pass" } },
  { downloaded: { ...valid.downloaded, commit: "b".repeat(40) } },
  { actualCommit: null }, { downloadVerified: false }, { visibleDelivery: false }, { pendingInteractions: 1 }, { monitorScheduled: true },
])("rejects a plausible incomplete or wrong result %j", fault => {
  expect(gradeAutomaticRepository({ ...valid, ...fault }).some(check => !check.passed)).toBe(true);
});

it("retains required lifecycle evidence while excluding provider content and unrelated task data", () => {
  const issue = { id: "task", companyId: "company", status: "done", description: "private description", privateToken: "private token" };
  const run = { id: "successor", companyId: "company", agentId: "agent", nativeIssueId: "task", status: "succeeded",
    wakeupRequestId: "dispatch", contextSnapshot: { source: "native_status_decision", nativeStatusWakeIntentId: "intent", paperclipWake: { prompt: "private prompt" } },
    resultJson: { finalizationPhase: "committed", nativeResult: { summary: "private provider text" } }, privateConfig: { secret: "private secret" } };
  for (const phase of ["completed", "failed"]) {
    const snapshot = automaticRepositoryApiState(phase, issue, [run], gradeAutomaticRepository(valid));
    expect(snapshot).toMatchObject({ capturePhase: phase, issue: { id: "task", status: "done" },
      runs: [{ id: "successor", wakeupRequestId: "dispatch", source: "native_status_decision", nativeStatusWakeIntentId: "intent", finalizationPhase: "committed" }] });
    expect(JSON.stringify(snapshot)).not.toMatch(/private|description|paperclipWake|nativeResult/);
  }
  const malformed = automaticRepositoryApiState("failed", issue, [{ ...run, contextSnapshot: { source: { private: true }, nativeStatusWakeIntentId: { private: true } }, resultJson: { finalizationPhase: { private: true } } }], []);
  expect(malformed.runs[0]).toMatchObject({ source: null, nativeStatusWakeIntentId: null, finalizationPhase: null });
});
