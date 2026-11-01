import { describe, expect, it } from "vitest";
import { isAgentJourney, parseTargetConfig, preparationPreview } from "./catalog.js";
import { taskDocumentHistoryPasses, taskDocumentMatches, type TaskDocumentRevision, type TaskDocumentSnapshot } from "./task-document-evidence.js";
import { journeyRequiredChecks } from "./success-contract.js";
import { validateRetainedRunnerResult } from "../result-validation.js";
import type { RunnerE2EResult } from "../types.js";

function evidence() {
  const original = { companyId: "company", issueId: "task", userId: "user", key: "qa-note", title: "Original title", body: "Original body" };
  const revised = { ...original, title: "Revised title", body: "Revised body" };
  const initial: TaskDocumentSnapshot = { id: "document", companyId: "company", issueId: "task", key: "qa-note", title: original.title, body: original.body,
    format: "markdown", latestRevisionId: "revision-1", latestRevisionNumber: 1,
    createdByUserId: "user", createdByAgentId: null, updatedByUserId: "user", updatedByAgentId: null };
  const current: TaskDocumentSnapshot = { ...initial, title: revised.title, body: revised.body, latestRevisionId: "revision-3", latestRevisionNumber: 3 };
  const revision = (document: TaskDocumentSnapshot): TaskDocumentRevision => ({ id: document.latestRevisionId!, documentId: document.id,
    companyId: document.companyId, issueId: document.issueId, key: document.key, title: document.title, body: document.body, format: document.format,
    revisionNumber: document.latestRevisionNumber, createdByUserId: "user", createdByAgentId: null, createdByRunId: null });
  const originalRevision = revision(initial);
  const currentRevision = revision(current);
  return { initial, current, original, revised, originalRevision, currentRevision, revisions: [originalRevision, currentRevision] };
}

describe("task document persistence oracle", () => {
  it("accepts exact canonical content and preserved revisions, including extra autosave revisions", () => {
    expect(taskDocumentHistoryPasses(evidence())).toBe(true);
    expect(taskDocumentMatches(undefined, evidence().original)).toBe(false);
  });

  it.each([
    ["wrong company", (e: ReturnType<typeof evidence>) => { e.current.companyId = "other"; }],
    ["wrong task", (e: ReturnType<typeof evidence>) => { e.current.issueId = "other"; }],
    ["wrong key", (e: ReturnType<typeof evidence>) => { e.current.key = "plan"; }],
    ["stale body", (e: ReturnType<typeof evidence>) => { e.current.body = e.original.body; }],
    ["stale title", (e: ReturnType<typeof evidence>) => { e.current.title = e.original.title; }],
    ["different document", (e: ReturnType<typeof evidence>) => { e.current.id = "other"; }],
    ["wrong author", (e: ReturnType<typeof evidence>) => { e.initial.createdByUserId = "other"; }],
    ["agent edit", (e: ReturnType<typeof evidence>) => { e.current.updatedByAgentId = "agent"; }],
    ["absent revision pointer", (e: ReturnType<typeof evidence>) => { e.current.latestRevisionId = null; }],
    ["unchanged revision", (e: ReturnType<typeof evidence>) => { e.current.latestRevisionId = e.initial.latestRevisionId; }],
    ["regressed revision number", (e: ReturnType<typeof evidence>) => { e.current.latestRevisionNumber = 1; }],
    ["missing history", (e: ReturnType<typeof evidence>) => { e.revisions = []; }],
    ["lost original", (e: ReturnType<typeof evidence>) => { e.revisions = [e.currentRevision]; }],
    ["overwritten original", (e: ReturnType<typeof evidence>) => { e.originalRevision.body = e.revised.body; }],
    ["wrong revision owner", (e: ReturnType<typeof evidence>) => { e.currentRevision.documentId = "other"; }],
    ["wrong revision scope", (e: ReturnType<typeof evidence>) => { e.originalRevision.companyId = "other"; }],
    ["agent-created revision", (e: ReturnType<typeof evidence>) => { e.currentRevision.createdByRunId = "run"; }],
    ["duplicate revision", (e: ReturnType<typeof evidence>) => { e.revisions.push(e.originalRevision); }],
    ["list differs from independent read", (e: ReturnType<typeof evidence>) => { e.revisions = [{ ...e.originalRevision, body: "Wrong" }, e.currentRevision]; }],
  ])("rejects %s", (_label, change) => {
    const input = evidence();
    change(input);
    expect(taskDocumentHistoryPasses(input)).toBe(false);
  });

  it("requires the complete closed browser-only result and zero model allowance", () => {
    const id = "task-document-persistence";
    const config = parseTargetConfig({ version: 1, id: "qa", mode: "existing-cloud", adapterModule: "/private/provider.mjs", journeys: [id],
      executionEnvironment: "daytona", baseline: { features: {}, connections: [] }, limits: { durationMs: 120_000, modelBudgetCents: 0, maxRuns: 0 } });
    expect(isAgentJourney(id)).toBe(false);
    expect(preparationPreview(config).journeys[0]).toMatchObject({ paid: false, capabilities: ["documents-artifacts/documents"], requires: ["company", "board-user", "task-write", "backlog-task"] });
    const result: RunnerE2EResult = { schema: "paperclip.runner-e2e.result/v2", executionId: `product-journeys.qa.browser.daytona.${id}`, suiteId: "product-journeys",
      suiteDefinitionHash: "definition", profileId: "browser", environmentId: "daytona", caseId: id, provider: null, model: null, runtimeMode: "none",
      status: "passed", attempt: 1, cleanup: "passed", startedAt: "2026-10-30T10:00:00Z", finishedAt: "2026-10-30T10:00:01Z", durationMs: 1000,
      productJourney: { outcome: "passed", startingState: "recipe", privacy: "private", resourceDisposition: "released", phases: [{ phase: "journey", outcome: "passed" }],
        checks: journeyRequiredChecks[id]!.map(id => ({ id, passed: true })), deployment: { kind: "cloud", targetId: "qa", origin: "https://qa.example.test", commit: "a".repeat(40),
          cloudRelease: "release", runtimeImage: null, configurationHash: "configuration" } } };
    expect(() => validateRetainedRunnerResult(result)).not.toThrow();
    for (const check of journeyRequiredChecks[id]!) {
      const partial = structuredClone(result);
      partial.productJourney!.checks = partial.productJourney!.checks.filter(item => item.id !== check);
      expect(() => validateRetainedRunnerResult(partial)).toThrow();
    }
    for (const unexpected of [{ runIds: ["run"] }, { runtimeMode: "native" as const }, { provider: "provider" }, { model: "model" }]) {
      expect(() => validateRetainedRunnerResult({ ...structuredClone(result), ...unexpected })).toThrow();
    }
  });
});
