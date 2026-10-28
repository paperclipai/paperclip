import { describe, expect, it } from "vitest";
import { buildNativeModelEnvelope } from "../../vendor/paperclip-runner/index.js";
import { caseExecutionMarkdown, caseFactsFingerprint, caseWakeWithInstructionReference, type CaseExecutionContext } from "../case-context.js";
import { buildNativeExecutionInput, type BuildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const task = { id: "task", identifier: "CASE-1", title: "Correct a receipt", description: "Produce the receipt.", workMode: "standard" };
const message = { id: "comment", body: "Please continue.", authorType: "user", authorId: "board", sourceTrust: "user", createdByRunId: null };

function context(options: { total?: number; revision?: string; phase?: string; incomingId?: string; instructions?: string; id?: string } = {}): CaseExecutionContext {
  const facts = {
    summary: "SAVED_CASE_FACTS ".repeat(200), fields: { total: options.total ?? 6 },
    documents: [{ key: "receipt", title: "Receipt", revisionId: options.revision ?? "revision-1" }],
    relatedTasks: [], workProducts: [],
  };
  return {
    id: options.id ?? "case", identifier: "CASE-C1", title: task.title, phase: options.phase ?? "triage",
    handoffVersion: options.phase ? 3 : 1, taskId: task.id, issueStatusVersion: options.phase ? 5 : 1,
    incomingHandoff: { id: options.incomingId ?? "handoff-1", commentId: options.incomingId ?? "handoff-1",
      fromAgentId: "sender", fromAgentName: "Sender", instructions: options.instructions ?? "TRIAGE_INSTRUCTIONS" },
    factsSha256: caseFactsFingerprint(facts), data: JSON.stringify({ ...facts, recentHandoffs: [{ phase: options.phase ?? "triage" }] }),
    omitted: false, readPath: `/api/cases/${options.id ?? "case"}`,
  };
}

function args(caseContext = context()): BuildNativeExecutionInput {
  return {
    companyId: "company", runId: "first", agentId: "agent", issue: task,
    taskPrompt: caseExecutionMarkdown(caseContext) + "TASK_BOOTSTRAP", caseContext,
    workspace: { id: "workspace", cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
    normalizedSessionId: "session", provider: "codex", runtimeContext: nativeRuntimeContextFixture(),
    completionContract: { id: "contract", sha256: "a".repeat(64), schemaVersion: "paperclip.run-result.v1",
      contract: { revision: "1", objective: "Produce a receipt", criteria: [{ id: "receipt", requirement: "Produce a receipt" }] } },
  };
}

type PriorInput = NonNullable<NonNullable<BuildNativeExecutionInput["previousTurn"]>["nativeExecutionInput"]>;

function resumed(current = context(), reason = "issue_commented", previous: PriorInput = buildNativeExecutionInput(args())) {
  return buildNativeExecutionInput({
    ...args(current), runId: "second", resumedSession: true,
    previousTurn: { runId: "first", task, nativeExecutionInput: previous },
    wakePayload: { reason, comments: [message], executionContinuation: {
      version: 1, objective: task.description, messages: [message], resumeDelta: { baseRunId: "first", messages: [message] },
    } },
  });
}

function events(input: ReturnType<typeof buildNativeExecutionInput>) {
  const envelope = buildNativeModelEnvelope(input, { resumedSession: true });
  expect(envelope.schema).toBe("paperclip.native-continuation.v1");
  if (!("events" in envelope)) throw new Error("Expected retained-session events");
  return JSON.parse(envelope.events);
}

describe("native workflow case projection", () => {
  it("keeps unchanged case facts in the retained session and sends current routing and versions", () => {
    const input = resumed(context({ phase: "verification" }));
    const delta = events(input);
    expect(delta.workflowCase).toMatchObject({ id: "case", phase: "verification", handoffVersion: 3,
      issueStatusVersion: 5, factsUnchanged: true, readPath: "/api/cases/case" });
    expect(delta.workflowCase.incomingHandoff).toBeUndefined();
    expect(JSON.stringify(delta)).not.toContain("SAVED_CASE_FACTS");
    expect(JSON.stringify(delta)).not.toContain("TRIAGE_INSTRUCTIONS");
    expect(JSON.stringify(delta).length).toBeLessThan(1_200);
    // A failed provider resume still has the complete, fresh bootstrap.
    expect(JSON.stringify(buildNativeModelEnvelope(input))).toContain("SAVED_CASE_FACTS");
  });

  it.each([{ total: 7 }, { revision: "revision-2" }])("refreshes changed facts on an ordinary comment: %j", change => {
    const delta = events(resumed(context(change)));
    expect(delta.workflowCase.data).toBe(context(change).data);
    expect(delta.workflowCase.factsUnchanged).toBeUndefined();
    expect(delta.messages).toEqual([message]);
  });

  it("delivers a returning agent's new handoff instructions exactly once", () => {
    const current = context({ phase: "correction", incomingId: "handoff-3", instructions: "NEW_CORRECTION_INSTRUCTIONS" });
    const base = resumed(current, "case_handoff");
    const input = buildNativeExecutionInput({
      ...args(current), runId: "second", resumedSession: true,
      previousTurn: { runId: "first", task, nativeExecutionInput: buildNativeExecutionInput(args()) },
      wakePayload: { reason: "case_handoff", executionContinuation: { version: 1, objective: task.description,
        resumeDelta: { baseRunId: "first", messages: [{ ...message, id: "handoff-3", body: current.incomingHandoff!.instructions }] } } },
    });
    expect(events(base).workflowCase.incomingHandoff.instructions).toBe("NEW_CORRECTION_INSTRUCTIONS");
    expect(events(input).messages).toEqual([]);
    expect(JSON.stringify(events(input)).split("NEW_CORRECTION_INSTRUCTIONS")).toHaveLength(2);
    expect(JSON.stringify(events(input))).not.toContain("SAVED_CASE_FACTS");
  });

  it("renders incoming instructions once on cold bootstrap, retaining source attribution", () => {
    const current = context();
    const incoming = { ...message, id: current.incomingHandoff!.commentId, body: current.incomingHandoff!.instructions };
    const input = buildNativeExecutionInput({ ...args(current), wakePayload: {
      reason: "case_handoff", issue: task, comments: [incoming], commentIds: [incoming.id], latestCommentId: incoming.id,
      executionContinuation: { version: 1, companyId: "company", issueId: task.id,
        objective: incoming.body, objectiveSource: { kind: "comment", id: incoming.id, revision: "now" },
        messages: [incoming], originCommentIds: [incoming.id] },
    } });
    expect(input.task.prompt.split(incoming.body)).toHaveLength(2);
    expect(input.task.prompt).toContain("/api/issues/task/comments");
    expect(input.task.prompt).toContain("board");
  });

  it.each([
    { body: "EDITED_SAME_COMMENT", deleted: false },
    { body: "", deleted: true },
  ])("preserves same-ID changed source events in compact input: %j", change => {
    const current = context();
    const incoming = { ...message, id: current.incomingHandoff!.commentId, ...change };
    const input = buildNativeExecutionInput({ ...args(current), runId: "second", resumedSession: true,
      previousTurn: { runId: "first", task, nativeExecutionInput: buildNativeExecutionInput(args(current)) },
      wakePayload: { reason: "issue_commented", executionContinuation: { version: 1,
        resumeDelta: { baseRunId: "first", messages: [incoming] } } } });
    expect(events(input).messages).toEqual([incoming]);
    expect(events(input).workflowCase.incomingHandoff).toBeUndefined();
  });

  it.each([
    { body: "EDITED_SAME_COMMENT", deleted: false },
    { body: "", deleted: true },
  ])("preserves same-ID changed source events in cold wake input: %j", change => {
    const current = context();
    const incoming = { ...message, id: current.incomingHandoff!.commentId, ...change };
    const wake = { reason: "case_handoff", comments: [incoming], executionContinuation: { version: 1,
      messages: [incoming], resumeDelta: { baseRunId: "first", messages: [incoming] } } };
    expect(caseWakeWithInstructionReference(wake, current)).toEqual(wake);
    const input = buildNativeExecutionInput({ ...args(current), wakePayload: wake });
    if (!change.deleted) expect(input.task.prompt).toContain(change.body);
    else expect(input.task.prompt).not.toContain("Read the source comment");
  });

  it("delivers withdrawn-source guidance on cold and resumed turns without the deleted old text", () => {
    const old = context({ instructions: "WITHDRAWN_OLD_INSTRUCTIONS" });
    const current = { ...context({ instructions: "The incoming handoff instruction comment was withdrawn. Read authorized task comments." }),
      incomingHandoff: { ...context().incomingHandoff!, instructions: "The incoming handoff instruction comment was withdrawn. Read authorized task comments.", sourceCommentDeleted: true } };
    const tombstone = { ...message, id: current.incomingHandoff.commentId, body: "", deleted: true };
    const wake = { reason: "issue_commented", comments: [tombstone], executionContinuation: { version: 1,
      messages: [tombstone], resumeDelta: { baseRunId: "first", messages: [tombstone] } } };
    const cold = buildNativeExecutionInput({ ...args(current), wakePayload: wake });
    expect(cold.task.prompt).toContain("withdrawn");
    expect(cold.task.prompt).not.toContain("WITHDRAWN_OLD_INSTRUCTIONS");
    const warm = buildNativeExecutionInput({ ...args(current), runId: "second", resumedSession: true,
      previousTurn: { runId: "first", task, nativeExecutionInput: buildNativeExecutionInput(args(old)) }, wakePayload: wake });
    expect(events(warm).messages).toEqual([tombstone]);
    expect(events(warm).workflowCase.incomingHandoff.sourceCommentDeleted).toBe(true);
    expect(JSON.stringify(events(warm))).not.toContain("WITHDRAWN_OLD_INSTRUCTIONS");
  });

  it("carries projection proof forward in the actually delivered continuation", () => {
    const prior = resumed();
    const next = buildNativeExecutionInput({ ...args(), runId: "third", resumedSession: true,
      previousTurn: { runId: "second", task, nativeExecutionInput: prior },
      wakePayload: { reason: "issue_commented", executionContinuation: { version: 1,
        resumeDelta: { baseRunId: "second", messages: [message] } } } });
    expect(events(next).workflowCase.factsUnchanged).toBe(true);
  });

  it.each(["pre-marker", "unknown-format", "different-case", "different-session", "different-base", "undelivered-full-backup"])(
    "uses the complete bootstrap when prior case delivery cannot be proven: %s", scenario => {
      let previous: PriorInput = buildNativeExecutionInput(args());
      let current = context();
      if (scenario === "pre-marker") previous = { ...previous, task: { ...previous.task, prompt: "OLD_CASE_SNAPSHOT" } };
      if (scenario === "unknown-format") previous = { ...previous, task: { ...previous.task, prompt: previous.task.prompt.replace("paperclip.case-projection.v1", "paperclip.case-projection.v999") } };
      if (scenario === "different-case") current = context({ id: "other-case" });
      if (scenario === "different-session") previous = { ...previous, session: { ...previous.session, normalizedSessionId: "other-session" } };
      if (scenario === "different-base") previous = { ...previous, binding: { ...previous.binding, runId: "other-run" } };
      if (scenario === "undelivered-full-backup") previous = { ...previous, continuationPrompt: JSON.stringify({ messages: [message] }) };
      const input = resumed(current, "issue_commented", previous);
      expect(input.continuationPrompt).toBeNull();
      expect(JSON.stringify(buildNativeModelEnvelope(input, { resumedSession: true }))).toContain("SAVED_CASE_FACTS");
    },
  );

  it.each([false, true])("keeps cold/reset sessions on full case bootstrap (reset=%s)", reset => {
    const input = buildNativeExecutionInput({ ...args(), resumedSession: false,
      normalizedSessionId: reset ? "fresh-session" : null,
      previousTurn: { runId: "first", task, nativeExecutionInput: buildNativeExecutionInput(args()) } });
    expect(input.continuationPrompt).toBeUndefined();
    expect(input.task.prompt).toContain("SAVED_CASE_FACTS");
    expect(input.task.prompt.split("TRIAGE_INSTRUCTIONS")).toHaveLength(2);
  });

  it.each([{ recovery: { cause: "interrupted" } }, { executionStage: { stageType: "review", wakeRole: "reviewer" } }, { fallbackFetchNeeded: true }])(
    "preserves specialized continuation exclusions: %j", extra => {
      const input = buildNativeExecutionInput({ ...args(), runId: "second", resumedSession: true,
        previousTurn: { runId: "first", task, nativeExecutionInput: buildNativeExecutionInput(args()) },
        wakePayload: { reason: "case_handoff", ...extra, executionContinuation: { version: 1,
          resumeDelta: { baseRunId: "first", messages: [message] } } } });
      expect(input.continuationPrompt).toBeNull();
    },
  );

  it("canonicalizes field object order without erasing changed document revisions", () => {
    expect(caseFactsFingerprint({ fields: { b: 2, a: 1 } })).toBe(caseFactsFingerprint({ fields: { a: 1, b: 2 } }));
    expect(context().factsSha256).not.toBe(context({ revision: "new" }).factsSha256);
  });

  it("keeps an unchanged 8 KiB field out of retained-session input", () => {
    const facts = { summary: "Receipt workflow", fields: { receiptNotes: "x".repeat(8_192) },
      documents: [{ key: "receipt", revisionId: "revision-1" }] };
    const current = { ...context(), data: JSON.stringify(facts), factsSha256: caseFactsFingerprint(facts) };
    const cold = buildNativeExecutionInput(args(current));
    const warm = resumed(current, "issue_commented", cold);
    const changedFacts = { ...facts, fields: { receiptNotes: "y".repeat(8_192) }, documents: [{ key: "receipt", revisionId: "revision-2" }] };
    const changed = resumed({ ...current, data: JSON.stringify(changedFacts), factsSha256: caseFactsFingerprint(changedFacts) }, "issue_commented", cold);
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(bytes(buildNativeModelEnvelope(warm, { resumedSession: true }))).toBeLessThan(bytes(buildNativeModelEnvelope(cold)) / 4);
    expect(events(changed).workflowCase.data).toBe(JSON.stringify(changedFacts));
    expect(JSON.stringify(events(warm))).not.toContain(facts.fields.receiptNotes);
  });
});
