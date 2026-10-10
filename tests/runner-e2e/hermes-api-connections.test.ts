import { describe, expect, it, vi } from "vitest";
import { runnerMatrix, runnerSuites, suiteDefinitionHash } from "./catalog.js";
import { buildMatrixJobs, parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
import { buildRunnerE2EProcessEnvironment } from "./harness-env.js";
import { explicitlyRequestsFileOutput, explicitlyRequestsTaskDocumentOutput } from "../../server/src/services/native-runtime/native-deliverable-feedback.js";
import { captureHermesApiAccountOwner, captureHermesApiBudgets, captureHermesApiSettlement, captureHermesOpenRouterSettlement, gradeHermesApiConnection, isHermesOpenRouterWorkflow, isHermesConnectionSuite, HERMES_NATIVE_INTERACTION_SUITE, hasExactHermesNativeQuestionResponse, hasHermesNativeQuestionBatch, hermesNativeAnswerText, hasHermesNativeQuestionStop, hasHermesNativeQuestionStopCard, resolveHermesQualificationBudgetCents, HERMES_IMAGE_INPUT_SUITE, HERMES_IMAGE_INPUT_MODEL, hermesImageChallenge, gradeHermesImageInput } from "./hermes-api-connections.js";
import { inflateSync } from "node:zlib";

describe("Hermes direct API billing oracle", () => {
  it.each(["anthropic", "openai"] as const)("requires a scoped complete %s estimate and healthy post-run budgets", async biller => {
    const model = biller === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-6-luna";
    for (const fault of ["valid", "decimal-only", "missing-price", "invalid-decimal", "mismatched-price", "reported", "partial", "model", "biller", "provenance", "paused", "pending"]) {
      const company = { id: "company", status: "active", budgetMonthlyCents: 200 };
      const agent = { id: "agent", companyId: "company", status: fault === "paused" ? "paused" : "idle", pauseReason: null, budgetMonthlyCents: 200 };
      const usage = { provider: biller, biller: fault === "biller" ? "unknown" : biller, model: fault === "model" ? "foreign" : model,
        billingType: "metered_api", costStatus: fault === "reported" ? "reported" : "estimated",
        costUsd: ["decimal-only", "missing-price"].includes(fault) ? null : 0.0042,
        costUsdExact: fault === "missing-price" ? null : fault === "invalid-decimal" ? "NaN" : fault === "mismatched-price" ? "0.004300000" : "0.004200000",
        inputTokens: 40, outputTokens: 10, accountingReceiptReady: true, accountingUsageComplete: fault !== "partial",
        pricingProvenance: { source: fault === "provenance" ? "agent_claim" : "rate_card",
          version: biller === "anthropic" ? "anthropic-standard-2026-10-09" : "openai-standard-2026-09-30" } };
      const run = { id: "run", companyId: "company", agentId: "agent", issueId: "task", status: "succeeded", usageJson: usage,
        costAccountingPending: fault === "pending", costAccountedAt: "2026-10-09T14:00:00Z" };
      const receipt = await captureHermesApiSettlement({ companyId: "company", agentId: "agent", issueId: "task", runId: "run", expectedBiller: biller, model,
        api: { async get<T>(path: string) { return (path === "/api/companies/company" ? company : path === "/api/agents/agent" ? agent : run) as T; } } });
      expect(receipt.checks.every(check => check.passed), `${biller}: ${fault}`).toBe(["valid", "decimal-only"].includes(fault));
    }
  });
});

describe("Hermes native image input", () => {
  const suite = runnerSuites.find(s => s.id === HERMES_IMAGE_INPUT_SUITE)!;
  const cells = runnerMatrix.filter(e => e.suite.id === suite.id);
  it("declares bounded OpenRouter, Claude API and OpenAI API image journeys on both targets", () => {
    expect(cells).toHaveLength(6);
    expect(new Set(cells.map(c => c.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(suite.manualOnly).toBe(true);
    expect(isHermesConnectionSuite(suite.id)).toBe(true);
    expect(new Set(cells.map(c => c.profile.credential))).toEqual(new Set(["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]));
    expect(cells.every(c => c.profile.qualificationCandidate === "hermes" && c.task.expectedRunCount === 1 && c.task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(cells.filter(c => c.profile.credential === "OPENROUTER_API_KEY").every(c => c.profile.model === HERMES_IMAGE_INPUT_MODEL)).toBe(true);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(c => c.suite.id === suite.id)).toBe(false);
    const env = buildRunnerE2EProcessEnvironment({}, [cells[0]!]);
    expect(JSON.parse(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "hermes", model: HERMES_IMAGE_INPUT_MODEL }]);
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cells[0]!, suite: { ...suite, manualOnly: false } }])).toThrow("explicit");
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cells[0]!, profile: { ...cells[0]!.profile, qualificationCandidate: "pi" } }])).toThrow("explicit");
    expect(suite.definitionMetadata).toMatchObject({ version: 4, qualification: "pending", providerTurns: 1,
      maximumAttemptsPerCell: 1, budgetMonthlyCents: 200 });
  });
  it("keeps the expected code out of prompt, filename and PNG metadata", () => {
    const image = hermesImageChallenge("image-fixture");
    expect(image.code).toMatch(/^[A-F0-9]{8}$/);
    expect(cells[0]!.task.buildPrompt("image-fixture")).not.toContain(image.code);
    expect(image.filename).not.toContain(image.code);
    expect(image.bytes.includes(Buffer.from(image.code))).toBe(false);
    expect(explicitlyRequestsFileOutput(cells[0]!.task.buildPrompt("image-fixture"))).toBe(false);
    expect(explicitlyRequestsTaskDocumentOutput(cells[0]!.task.buildPrompt("image-fixture"))).toBe(false);
    expect(image.bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const chunks: { name: string; body: Buffer }[] = [];
    for (let at = 8; at < image.bytes.length;) {
      const size = image.bytes.readUInt32BE(at);
      chunks.push({ name: image.bytes.subarray(at + 4, at + 8).toString(), body: image.bytes.subarray(at + 8, at + 8 + size) });
      at += size + 12;
    }
    expect(chunks.map(c => c.name)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks[0]!.body.readUInt32BE(0)).toBe(880);
    expect(chunks[0]!.body.readUInt32BE(4)).toBe(192);
    const pixels = inflateSync(chunks[1]!.body);
    expect(pixels.length).toBe((880 * 3 + 1) * 192);
    expect(pixels.subarray(1, 880 * 3 + 1).every(byte => byte === 255)).toBe(true);
    expect(pixels.filter(byte => byte === 0).length).toBeGreaterThan(10_000);
    expect(hermesImageChallenge("image-fixture").bytes).toEqual(image.bytes);
    expect(hermesImageChallenge("different-fixture").bytes).not.toEqual(image.bytes);
  });
  const evidence = () => {
    const image = hermesImageChallenge("image-fixture");
    return { nonce: "image-fixture", companyId: "company", issueId: "task", runId: "run", downloadedBytes: image.bytes,
      attachments: [{ id: "attachment", companyId: "company", issueId: "task", originalFilename: image.filename,
        contentType: "image/png", byteSize: image.bytes.length, sha256: image.sha256 }],
      events: [{ runId: "run", eventType: "tool.execution.started", payload: { prpEvent: {
        schema: "paperclip.prp.event.v1", runId: "run", sourceKind: "runner", sourceInstanceId: "runner", normalizedSessionId: "session",
        payload: { name: "paperclip_finish", namespace: "paperclip" },
      } } }],
    };
  };
  it("accepts independently downloaded matching bytes with native semantic completion", () => {
    expect(gradeHermesImageInput(evidence()).every(c => c.passed)).toBe(true);
  });
  it.each(["companyId", "issueId", "originalFilename", "contentType", "sha256"])("rejects an image with the wrong %s", key => {
    const input = evidence(); Object.assign(input.attachments[0]!, { [key]: "different" });
    expect(gradeHermesImageInput(input).every(c => c.passed)).toBe(false);
  });
  it.each(["missing", "duplicate", "size", "bytes", "no-tools", "file-tool", "foreign-run", "foreign-native-run", "no-runner", "no-session"])("rejects %s evidence", variant => {
    const input = evidence();
    if (variant === "missing") input.attachments = [];
    if (variant === "duplicate") input.attachments.push({ ...input.attachments[0]! });
    if (variant === "size") input.attachments[0]!.byteSize++;
    if (variant === "bytes") input.downloadedBytes = Buffer.from("not the image");
    if (variant === "no-tools") input.events = [];
    if (variant === "file-tool") input.events[0]!.payload.prpEvent.payload.name = "read_task_attachment";
    if (variant === "foreign-run") input.events[0]!.runId = "foreign";
    if (variant === "foreign-native-run") input.events[0]!.payload.prpEvent.runId = "foreign";
    if (variant === "no-runner") input.events[0]!.payload.prpEvent.sourceInstanceId = "";
    if (variant === "no-session") input.events[0]!.payload.prpEvent.normalizedSessionId = "";
    expect(gradeHermesImageInput(input).every(c => c.passed)).toBe(false);
  });
});

const settings = vi.hoisted(() => ({ contents: undefined as string | undefined }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: ((file: Parameters<typeof actual.readFileSync>[0], options: unknown) =>
    settings.contents !== undefined && String(file).endsWith("/.env.runner-e2e.local")
      ? settings.contents : actual.readFileSync(file, options as never)) };
});

describe("Hermes native browser questions", () => {
  const suite = runnerSuites.find(s => s.id === HERMES_NATIVE_INTERACTION_SUITE)!;
  const cells = runnerMatrix.filter(e => e.suite.id === suite.id);
  const questionSet = { schema: "paperclip.question_set.v1", questions: [
    { id: "q0", prompt: "Choose the fixture color", required: true, answerMode: "single_select",
      options: [{ id: "o0", label: "Cobalt (Recommended)" }, { id: "o1", label: "Amber" }], customAnswer: { enabled: true } },
    { id: "q1", prompt: "Choose the fixture targets", required: true, answerMode: "multi_select",
      options: [{ id: "o0", label: "Linux" }, { id: "o1", label: "Mac" }], customAnswer: { enabled: true } },
    { id: "q2", prompt: "Describe the fixture constraint", required: true, answerMode: "text" },
  ] };
  const response = { schema: "paperclip.question_response.v1", answers: {
    q0: { selectedOptionIds: ["o0"] }, q1: { selectedOptionIds: ["o0", "o1"], customText: "FreeBSD" }, q2: { text: "Reviewer constraint" },
  } };
  const event = (eventType: string, sourceSeq: number, payload: unknown) => ({
    runId: "run", protocolSchemaVersion: 1, payload: { prpEvent: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, runId: "run", turnId: "turn", eventType, sourceSeq, payload,
      sourceKind: "runner", sourceInstanceId: "instance", normalizedSessionId: "session",
    } },
  });
  const native = (adapter = "acpx-runtime-sidecar") => [
    event("runtime_request.created", 2, { request: { requestId: "request", turnId: "turn", type: "input", status: "pending", input: questionSet,
      origin: { adapter, provider: "hermes", method: "_hermes/ask_questions" } } }),
    event("runtime_request.resolved", 3, { requestId: "request", turnId: "turn", action: "submit", response }),
  ];
  const grade = (events: unknown[]) => hasExactHermesNativeQuestionResponse({ events, runId: "run", turnId: "turn", requestId: "request", questionSet, response });
  it("declares nine explicit bounded API cells with local-only Stop ownership proof", () => {
    expect(cells).toHaveLength(9);
    expect(suite.manualOnly).toBe(true);
    expect(cells.filter(cell => cell.task.flow === "native_question_stop").map(cell => cell.environment.id)).toEqual(["local", "local", "local"]);
    expect(new Set(cells.map(cell => cell.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(cells.every(cell => cell.profile.qualificationCandidate === "hermes" && ["native_question_completion", "native_question_stop"].includes(cell.task.flow)
      && cell.task.expectedRunCount === 1 && cell.task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(suite.definitionMetadata).toMatchObject({ qualification: "pending", providerTurns: 1, maximumAttemptsPerCell: 1, budgetMonthlyCents: 200,
      lifecycle: "per-turn", nativeMethod: "_hermes/ask_questions", billing: "reported-openrouter-or-estimated-direct-api-cost-and-budget-health" });
    expect(isHermesConnectionSuite(suite.id)).toBe(true);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(cell => cell.suite.id === suite.id)).toBe(false);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--id", cells[0]!.id]))).toEqual([cells[0]]);
    expect(suite.definitionMetadata?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    const env = buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [cells[0]!]);
    expect(JSON.parse(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "hermes", model: cells[0]!.profile.model }]);
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cells[0]!, suite: { ...suite, manualOnly: false } }])).toThrow("explicit");
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cells[0]!, profile: { ...cells[0]!.profile, qualificationCandidate: "pi" } }])).toThrow("explicit");
    const answer = hermesNativeAnswerText("fixture-1");
    expect(cells[0]!.task.buildPrompt("fixture-1")).not.toContain(answer);
    expect(cells[0]!.task.buildVisibleMarker("fixture-1")).toContain(answer);
  });
  it("admits a question-only objective through the production delivery guard without suppressing file requirements", () => {
    const prompt = cells[0]!.task.buildPrompt("fixture-guard");
    expect(explicitlyRequestsFileOutput(prompt)).toBe(false);
    expect(explicitlyRequestsTaskDocumentOutput(prompt)).toBe(false);
    expect(explicitlyRequestsFileOutput("Write a JSON file with the returned answers.")).toBe(true);
    expect(explicitlyRequestsTaskDocumentOutput("Write a document on this task with the returned answers.")).toBe(true);
  });
  const stopped = () => {
    const events = [native()[0]!,
      event("runtime_request.cancelled", 3, { requestId: "request", turnId: "turn", itemId: "clarify-tool", requestKind: "runtime", action: "cancel", reason: "provider request aborted" }),
      event("turn.cancelled", 4, { status: "cancelled", error: null }),
    ];
    Object.assign((events[0]!.payload.prpEvent.payload as Record<string, any>).request, { itemId: "clarify-tool", requestKind: "runtime" });
    const run = { id: "run", companyId: "company", issueId: "task", runtimeMode: "native", status: "cancelled", resultJson: {
      cancelledByActorType: "user", cancelledByUserId: "caller", nativeCancellation: {
        schema: "paperclip.native-cancellation.v1", companyId: "company", runId: "run", issueId: "task", scope: "run",
        dispatched: true, dispatchState: "acknowledged", reasonCode: "cancellation_run_only", effects: ["release_run_resources"],
        intentId: "intent", intentAuditId: "audit-intent", acknowledgementAuditId: "audit-ack",
      },
    } };
    return { events, run, pendingEvent: structuredClone(events[0]!.payload.prpEvent), issue: { id: "task", companyId: "company", status: "in_progress" },
      runId: "run", turnId: "turn", requestId: "request", questionSet, companyId: "company", callerUserId: "caller", browserResponse: structuredClone(run) };
  };
  it("requires the native callback cancellation and exact browser-owned Stop acknowledgement", () => {
    expect(hasHermesNativeQuestionStop(stopped())).toBe(true);
  });
  const stoppedCard = () => {
    const originalCard = { id: "card", companyId: "company", issueId: "task", sourceRunId: "run", kind: "ask_user_questions",
      continuationPolicy: "none", status: "pending", result: null, payload: { version: 1, runtimeRequestId: "request", questionSet } };
    return { originalCard, runId: "run", card: { ...structuredClone(originalCard), status: "expired", resolvedByRunId: "run",
      resolvedByUserId: null, resolvedByAgentId: null,
      result: { version: 1, cancelled: true, cancellationReason: "Native question cancelled", answers: [], summaryMarkdown: null } } };
  };
  it("accepts the persisted native cancellation receipt with no submitted answers", () => {
    expect(hasHermesNativeQuestionStopCard(stoppedCard())).toBe(true);
  });
  it.each(["missing-receipt", "answered", "not-cancelled", "wrong-version", "wrong-reason", "summary", "foreign-card", "foreign-company",
    "foreign-task", "foreign-source-run", "foreign-resolver-run", "resolved-by-user", "resolved-by-agent", "changed-payload", "wrong-status",
    "wrong-kind", "continuation", "original-answered", "original-expired", "missing-request", "wrong-run"])("rejects stopped card fault: %s", fault => {
    const value = stoppedCard() as Record<string, any>;
    if (fault === "missing-receipt") value.card.result = null;
    if (fault === "answered") value.card.result.answers = [{ questionId: "q0", optionIds: ["o0"] }];
    if (fault === "not-cancelled") value.card.result.cancelled = false;
    if (fault === "wrong-version") value.card.result.version = 2;
    if (fault === "wrong-reason") value.card.result.cancellationReason = "Another cancellation";
    if (fault === "summary") value.card.result.summaryMarkdown = "An answer";
    if (fault === "foreign-card") value.card.id = "other-card";
    if (fault === "foreign-company") value.card.companyId = "other-company";
    if (fault === "foreign-task") value.card.issueId = "other-task";
    if (fault === "foreign-source-run") value.card.sourceRunId = "other-run";
    if (fault === "foreign-resolver-run") value.card.resolvedByRunId = "other-run";
    if (fault === "resolved-by-user") value.card.resolvedByUserId = "human";
    if (fault === "resolved-by-agent") value.card.resolvedByAgentId = "agent";
    if (fault === "changed-payload") value.card.payload.runtimeRequestId = "other-request";
    if (fault === "wrong-status") value.card.status = "answered";
    if (fault === "wrong-kind") value.card.kind = "request_confirmation";
    if (fault === "continuation") value.card.continuationPolicy = "resume_task";
    if (fault === "original-answered") value.originalCard.result = { answers: [{ questionId: "q0", optionIds: ["o0"] }] };
    if (fault === "original-expired") value.originalCard.status = "expired";
    if (fault === "missing-request") { delete value.originalCard.payload.runtimeRequestId; delete value.card.payload.runtimeRequestId; }
    if (fault === "wrong-run") value.runId = "other-run";
    expect(hasHermesNativeQuestionStopCard(value as Parameters<typeof hasHermesNativeQuestionStopCard>[0])).toBe(false);
  });
  it.each(["missing-created", "missing-closure", "missing-terminal", "duplicate-created", "duplicate-closure", "duplicate-terminal", "second-request",
    "completed", "failed", "interrupted", "resolved", "expired", "answer", "replay", "wrong-action", "wrong-order", "wrong-schema", "wrong-version", "wrong-protocol",
    "foreign-row", "foreign-event", "foreign-turn", "foreign-session", "foreign-source", "not-runner", "changed-pending", "changed-input", "wrong-provider", "semantic-tool",
    "post-stop-tool", "post-stop-question", "task-completed", "foreign-company", "foreign-task", "foreign-caller", "wrong-actor", "run-succeeded",
    "missing-ack", "wrong-scope", "wrong-effects", "no-audit", "same-audit", "wrong-browser-intent", "wrong-browser-run"])("rejects native Stop fault: %s", fault => {
    const value = stopped() as Record<string, any>;
    const created = value.events[0].payload.prpEvent, closed = value.events[1].payload.prpEvent, terminal = value.events[2].payload.prpEvent;
    const request = created.payload.request, stop = value.run.resultJson.nativeCancellation;
    if (fault === "missing-created") value.events.splice(0,1);
    if (fault === "missing-closure") value.events.splice(1,1);
    if (fault === "missing-terminal") value.events.splice(2,1);
    if (fault === "duplicate-created") value.events.push(structuredClone(value.events[0]));
    if (fault === "duplicate-closure") value.events.push(structuredClone(value.events[1]));
    if (fault === "duplicate-terminal") value.events.push(structuredClone(value.events[2]));
    if (fault === "second-request") { const extra = structuredClone(value.events[0]); extra.payload.prpEvent.payload.request.requestId="other"; value.events.push(extra); }
    if (["completed","failed","interrupted"].includes(fault)) terminal.eventType=`turn.${fault}`;
    if (["resolved","expired"].includes(fault)) closed.eventType=`runtime_request.${fault}`;
    if (fault === "answer") closed.payload.response=response;
    if (fault === "replay") closed.payload.replayAllowed=true;
    if (fault === "wrong-action") closed.payload.action="submit";
    if (fault === "wrong-order") terminal.sourceSeq=2;
    if (fault === "wrong-schema") closed.schema="made-up";
    if (fault === "wrong-version") closed.schemaVersion=2;
    if (fault === "wrong-protocol") value.events[1].protocolSchemaVersion=2;
    if (fault === "foreign-row") value.events[1].runId="foreign";
    if (fault === "foreign-event") closed.runId="foreign";
    if (fault === "foreign-turn") closed.turnId="foreign";
    if (fault === "foreign-session") closed.normalizedSessionId="foreign";
    if (fault === "foreign-source") closed.sourceInstanceId="foreign";
    if (fault === "not-runner") closed.sourceKind="control_plane";
    if (fault === "changed-pending") value.pendingEvent.sourceSeq=1;
    if (fault === "changed-input") request.input={};
    if (fault === "wrong-provider") request.origin.provider="cursor";
    if (fault === "semantic-tool") request.origin.method="request_human_input";
    if (fault === "post-stop-tool") value.events.push(event("tool.execution.started",5,{}));
    if (fault === "post-stop-question") value.events.push(event("runtime_request.created",5,{request:{}}));
    if (fault === "task-completed") value.issue.status="done";
    if (fault === "foreign-company") value.run.companyId="foreign";
    if (fault === "foreign-task") value.run.issueId="foreign";
    if (fault === "foreign-caller") value.run.resultJson.cancelledByUserId="foreign";
    if (fault === "wrong-actor") value.run.resultJson.cancelledByActorType="agent";
    if (fault === "run-succeeded") value.run.status="succeeded";
    if (fault === "missing-ack") stop.dispatchState="pending";
    if (fault === "wrong-scope") stop.scope="agent";
    if (fault === "wrong-effects") stop.effects=["cancel_task"];
    if (fault === "no-audit") delete stop.acknowledgementAuditId;
    if (fault === "same-audit") stop.acknowledgementAuditId=stop.intentAuditId;
    if (fault === "wrong-browser-intent") value.browserResponse.resultJson.nativeCancellation.intentId="foreign";
    if (fault === "wrong-browser-run") value.browserResponse.id="foreign";
    expect(hasHermesNativeQuestionStop(value as Parameters<typeof hasHermesNativeQuestionStop>[0])).toBe(false);
  });
  it.each(["acpx-runtime", "acpx-runtime-sidecar"])("accepts a complete native delivery from %s", adapter => {
    expect(hasHermesNativeQuestionBatch(questionSet)).toBe(true);
    expect(grade(native(adapter))).toBe(true);
  });
  it.each(["missing", "no-created", "no-outcome", "duplicate-created", "duplicate-outcome", "second-request-other-id", "cancelled", "expired", "wrong-action", "wrong-answer",
    "wrong-answer-order", "wrong-input", "wrong-provider", "semantic-tool", "wrong-adapter", "wrong-type", "wrong-status", "wrong-request-turn",
    "wrong-event-turn", "wrong-outcome-turn", "foreign-row", "foreign-event", "wrong-schema", "wrong-version", "wrong-protocol", "wrong-order", "missing-sequence",
    "foreign-source", "foreign-session", "not-runner", "created-not-runner", "missing-source", "missing-session"])("rejects %s evidence", fault => {
    const rows = structuredClone(native()) as ReturnType<typeof native>;
    const created = rows[0]!.payload.prpEvent as Record<string, any>, resolved = rows[1]!.payload.prpEvent as Record<string, any>;
    const request = created.payload.request;
    if (fault === "missing") rows.length = 0;
    if (fault === "no-created") rows.splice(0, 1);
    if (fault === "no-outcome") rows.splice(1, 1);
    if (fault === "duplicate-created") rows.push(structuredClone(rows[0]!));
    if (fault === "duplicate-outcome") rows.push(structuredClone(rows[1]!));
    if (fault === "second-request-other-id") {
      const extra = structuredClone(rows[0]!);
      (extra.payload.prpEvent.payload as Record<string, any>).request.requestId = "different-request";
      rows.push(extra);
    }
    if (fault === "cancelled") resolved.eventType = "runtime_request.cancelled";
    if (fault === "expired") resolved.eventType = "runtime_request.expired";
    if (fault === "wrong-action") resolved.payload.action = "cancel";
    if (fault === "wrong-answer") resolved.payload.response.answers.q2.text = "Guessed answer";
    if (fault === "wrong-answer-order") resolved.payload.response.answers.q1.selectedOptionIds.reverse();
    if (fault === "wrong-input") request.input.questions[2].prompt = "Different question";
    if (fault === "wrong-provider") request.origin.provider = "cursor";
    if (fault === "semantic-tool") request.origin.method = "request_human_input";
    if (fault === "wrong-adapter") request.origin.adapter = "test-hook";
    if (fault === "wrong-type") request.type = "permission";
    if (fault === "wrong-status") request.status = "resolved";
    if (fault === "wrong-request-turn") request.turnId = "other";
    if (fault === "wrong-event-turn") resolved.turnId = "other";
    if (fault === "wrong-outcome-turn") resolved.payload.turnId = "other";
    if (fault === "foreign-row") rows[1]!.runId = "foreign";
    if (fault === "foreign-event") resolved.runId = "foreign";
    if (fault === "wrong-schema") resolved.schema = "made-up";
    if (fault === "wrong-version") resolved.schemaVersion = 2;
    if (fault === "wrong-protocol") rows[1]!.protocolSchemaVersion = 2;
    if (fault === "wrong-order") resolved.sourceSeq = 1;
    if (fault === "missing-sequence") delete resolved.sourceSeq;
    if (fault === "foreign-source") resolved.sourceInstanceId = "another-runner";
    if (fault === "foreign-session") resolved.normalizedSessionId = "another-session";
    if (fault === "not-runner") resolved.sourceKind = "controller";
    if (fault === "created-not-runner") created.sourceKind = "controller";
    if (fault === "missing-source") delete created.sourceInstanceId;
    if (fault === "missing-session") delete created.normalizedSessionId;
    expect(grade(rows)).toBe(false);
  });
  it.each(["question-count", "mode", "id", "prompt", "required", "choices", "option-id", "option-label", "custom-disabled"])("rejects a changed native form: %s", fault => {
    const form = structuredClone(questionSet) as Record<string, any>;
    if (fault === "question-count") form.questions.pop();
    if (fault === "mode") form.questions[1].answerMode = "single_select";
    if (fault === "id") form.questions[0].id = "color";
    if (fault === "prompt") form.questions[0].prompt = "Choose something else";
    if (fault === "required") form.questions[0].required = false;
    if (fault === "choices") form.questions[1].options.pop();
    if (fault === "option-id") form.questions[0].options[0].id = "cobalt";
    if (fault === "option-label") form.questions[0].options[0].label = "Cobalt impostor";
    if (fault === "custom-disabled") form.questions[1].customAnswer.enabled = false;
    expect(hasHermesNativeQuestionBatch(form)).toBe(false);
  });
});

describe("Hermes managed API connection qualification", () => {
  it.each(["0", "201", "100.0", ""])("rejects invalid local settings budget %s before catalog construction", async raw => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS", undefined);
    settings.contents = `PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS=${raw}\n`;
    vi.resetModules();
    try {
      await expect(import("./catalog.js")).rejects.toThrow("integer from 1 to 200 cents");
      expect(process.env.PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS).toBeUndefined();
    } finally {
      settings.contents = undefined;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it("preserves an explicit environment budget ahead of local settings", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS", "100");
    settings.contents = "PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS=0\n";
    vi.resetModules();
    try {
      const bounded = await import("./hermes-api-connections.js");
      expect(bounded.HERMES_API_CONNECTION_BUDGET_CENTS).toBe(100);
      expect(process.env.PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS).toBe("100");
    } finally {
      settings.contents = undefined;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it("captures the local settings budget before catalog construction and pins it for child processes", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS", undefined);
    const existingCredential = process.env.OPENROUTER_API_KEY;
    settings.contents = "# Fixture-only public configuration\nexport PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS='100'\nOPENROUTER_API_KEY=never-load-this-fixture-value\n";
    vi.resetModules();
    try {
      const catalog = await import("./catalog.js");
      const bounded = await import("./hermes-api-connections.js");
      const cell = catalog.runnerMatrix.find(cell => cell.id === "hermes-native-interactions.runner-acpx-hermes.local.native-question-batch-stop")!;
      expect(bounded.HERMES_API_CONNECTION_BUDGET_CENTS).toBe(100);
      expect(cell.suite.definitionMetadata).toMatchObject({ budgetMonthlyCents: 100 });
      expect(process.env.PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS).toBe("100");
      const child = buildRunnerE2EProcessEnvironment(process.env, [cell]);
      expect(child.PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS).toBe("100");
      expect(process.env.OPENROUTER_API_KEY).toBe(existingCredential);
      // The late full settings loader preserves an already captured value.
      settings.contents = "PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS=200\n";
      vi.resetModules();
      const reloaded = await import("./catalog.js");
      const next = reloaded.runnerMatrix.find(next => next.id === cell.id)!;
      expect(next.suiteDefinitionHash).toBe(cell.suiteDefinitionHash);
      expect(next.suite.definitionMetadata).toMatchObject({ budgetMonthlyCents: 100 });
    } finally {
      settings.contents = undefined;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
  it.each([[undefined, 200], ["1", 1], ["100", 100], ["200", 200]] as const)("admits the bounded campaign limit %s", (raw, expected) => {
    expect(resolveHermesQualificationBudgetCents(raw)).toBe(expected);
  });
  it.each(["", "0", "201", "999", "1000", "-100", "+100", "100.0", "1e2", "0100", " 100", "100 ", "NaN", "Infinity"])("rejects an unlimited or malformed campaign limit %s", raw => {
    expect(() => resolveHermesQualificationBudgetCents(raw)).toThrow("integer from 1 to 200 cents");
  });
  it("pins a lowered campaign budget in catalog metadata and both public budget checks", async () => {
    vi.stubEnv("PAPERCLIP_RUNNER_E2E_HERMES_BUDGET_CENTS", "100");
    vi.resetModules();
    try {
      const bounded = await import("./hermes-api-connections.js");
      const catalog = await import("./catalog.js");
      expect(bounded.HERMES_API_CONNECTION_BUDGET_CENTS).toBe(100);
      const suite = catalog.runnerSuites.find(suite => suite.id === HERMES_NATIVE_INTERACTION_SUITE)!;
      expect(suite.definitionMetadata).toMatchObject({ budgetMonthlyCents: 100, maximumAttemptsPerCell: 1 });
      expect(catalog.suiteDefinitionHash(suite)).not.toBe(suiteDefinitionHash(runnerSuites.find(suite => suite.id === HERMES_NATIVE_INTERACTION_SUITE)!));
      for (const observed of [100, 200, 0]) {
        const receipt = await bounded.captureHermesApiBudgets({ companyId: "company", agentId: "agent", api: {
          async get<T>(path: string) { return (path === "/api/companies/company"
            ? { id: "company", budgetMonthlyCents: observed }
            : { id: "agent", companyId: "company", budgetMonthlyCents: observed }) as T; },
        } });
        expect(receipt.budgetMonthlyCents).toBe(100);
        expect(receipt.checks.every(check => check.passed)).toBe(observed === 100);
        const company = { id: "company", status: "active", budgetMonthlyCents: observed };
        const agent = { id: "agent", companyId: "company", status: "idle", pauseReason: null, budgetMonthlyCents: observed };
        const run = { id: "run", companyId: "company", agentId: "agent", issueId: "task", status: "cancelled",
          costAccountingPending: false, costAccountedAt: "2026-10-08T03:00:00Z", usageJson: {
            biller: "openrouter", billingType: "metered_api", costStatus: "reported", costUsd: 0.0042, costUsdExact: "0.004200000",
            inputTokens: 40, outputTokens: 10, accountingReceiptReady: true,
            pricingProvenance: { source: "provider_reported", version: "hermes-openrouter-wire/v1" },
          } };
        const settled = await bounded.captureHermesOpenRouterSettlement({ companyId: "company", agentId: "agent", issueId: "task",
          runId: "run", expectedRunStatus: "cancelled", api: { async get<T>(path: string) {
            return (path === "/api/companies/company" ? company : path === "/api/agents/agent" ? agent : run) as T;
          } } });
        expect(settled.checks.every(check => check.passed)).toBe(observed === 100);
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  const suite = runnerSuites.find(s => s.id === "hermes-api-connections")!;
  const cells = runnerMatrix.filter(e => e.suite.id === suite.id);
  it("declares ten bounded pending cells without adding scheduled paid work", () => {
    expect(cells).toHaveLength(10);
    expect(suite.manualOnly).toBe(true);
    expect(new Set(cells.map(e => e.environment.id))).toEqual(new Set(["local", "daytona"]));
    expect(cells.every(e => e.task.id === "hello-complete" && e.task.expectedRunCount === 1 && e.task.automaticRetryPolicy === "single_attempt")).toBe(true);
    expect(suite.definitionMetadata).toMatchObject({ qualification: "pending", accountMethod: "api_key", accountMode: "responsible_user", coverage: "api-account-native-completion-only", budgetMonthlyCents: 200, maximumAttemptsPerCell: 1 });
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(e => e.suite.id === suite.id)).toBe(false);
  });
  it("requires accounting for every Hermes OpenRouter product workflow without widening other provider cells", () => {
    const workflow = runnerMatrix.filter(isHermesOpenRouterWorkflow);
    expect(workflow).toHaveLength(10);
    expect(new Set(workflow.map(cell => cell.task.id))).toEqual(new Set([
      "hello-complete", "question-resume-complete", "plan-approve-complete", "structured-question-restart-resume", "file-edit-validate",
    ]));
    expect(workflow.every(cell => cell.suite.definitionMetadata?.hermesBudgetMonthlyCents === 200)).toBe(true);
    expect(isHermesOpenRouterWorkflow({ ...workflow[0]!, profile: { ...workflow[0]!.profile, qualificationCandidate: "cursor" } })).toBe(false);
    expect(isHermesOpenRouterWorkflow({ ...workflow[0]!, profile: { ...workflow[0]!.profile, credential: "ANTHROPIC_API_KEY" } })).toBe(false);
  });
  it.each([
    ["XAI_API_KEY", "grok-4.7"],
    ["GEMINI_API_KEY", "gemini-3.8-flash"],
  ])("pins the %s candidate and model in the operator admission", (credential, model) => {
    const cell = cells.find(e => e.profile.credential === credential)!;
    const env = buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [cell]);
    expect(JSON.parse(env.PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent: "hermes", model }]);
    expect(() => buildRunnerE2EProcessEnvironment({}, [{ ...cell, suite: { ...suite, manualOnly: false } }])).toThrow("explicit");
    expect(cells.every(e => e.profile.modelQualification.source === "candidate_runner_profile")).toBe(true);
    expect(buildMatrixJobs(cells).every(job => job.qualificationCandidate === "hermes")).toBe(true);
    expect(cells.every(e => e.profile.id.startsWith("runner-acpx-"))).toBe(true);
  });
  it("retains account-fixture source provenance in its historical definition", () => {
    expect(suite.definitionMetadata?.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(suiteDefinitionHash({ ...suite, definitionMetadata: { ...suite.definitionMetadata, sourceDigest: "changed-account-selection" } })).not.toBe(suiteDefinitionHash(suite));
  });
  const valid = {
    companyId: "company", agentId: "agent", issueId: "task", connectionId: "account", provider: "xai", model: "grok-4.7", expectedResponsibleUserId: "user",
    runs: [{ companyId: "company", agentId: "agent", issueId: "task", status: "succeeded", runtimeMode: "native", responsibleUserId: "user",
      contextSnapshot: { aiConnection: { connectionId: "account", provider: "xai", method: "api_key", mode: "responsible_user", responsibleUserId: "user" } },
      runnerProfileJson: { nativeExecutionInput: { provider: { kind: "acpx", agent: "hermes", model: "grok-4.7" } },
        sessionCheckpoint: { providerIdentity: { kind: "acpx", requestedModel: "grok-4.7", effectiveModel: "grok-4.7" } } } }],
  };
  it("accepts independently observed account/model metadata", () => {
    expect(gradeHermesApiConnection(valid).every(check => check.passed)).toBe(true);
  });
  it("grades cancelled account metadata only when cancellation is explicitly expected", () => {
    const value = { ...valid, runs: [{ ...valid.runs[0]!, status: "cancelled" }] };
    expect(gradeHermesApiConnection(value).every(check => check.passed)).toBe(false);
    expect(gradeHermesApiConnection({ ...value, expectedRunStatus: "cancelled" }).every(check => check.passed)).toBe(true);
  });

  it.each(["valid", "reported-zero", "cancelled", "unexpected-cancelled", "cancelled-pending", "failed-cancellation", "company-scope", "agent-scope", "run-scope", "task-scope", "paused-agent", "paused-company", "pause-reason", "budget-changed",
    "pending", "missing-settlement", "missing-price", "estimated", "partial", "wrong-biller", "wrong-provenance", "mismatched-exact", "unknown-tokens"])("calibrates public OpenRouter settlement: %s", async fault => {
    const company: Record<string, unknown> = { id: "company", status: "active", budgetMonthlyCents: 200 };
    const agent: Record<string, unknown> = { id: "agent", companyId: "company", status: "idle", pauseReason: null, budgetMonthlyCents: 200 };
    const usage: Record<string, unknown> = { biller: "openrouter", billingType: "metered_api", costStatus: "reported", costUsd: 0.0042, costUsdExact: "0.004200000",
      inputTokens: 40, outputTokens: 10, accountingReceiptReady: true, pricingProvenance: { source: "provider_reported", version: "hermes-openrouter-wire/v1" } };
    const run: Record<string, unknown> = { id: "run", companyId: "company", agentId: "agent", issueId: "task", status: "succeeded", usageJson: usage,
      costAccountingPending: false, costAccountedAt: "2026-10-08T03:00:00Z" };
    if (fault === "reported-zero") { usage.costUsd = 0; usage.costUsdExact = "0.000000000"; }
    if (["cancelled", "unexpected-cancelled", "cancelled-pending"].includes(fault)) run.status="cancelled";
    if (fault === "cancelled-pending") run.costAccountingPending=true;
    if (fault === "failed-cancellation") run.status="failed";
    if (fault === "company-scope") company.id = "foreign";
    if (fault === "agent-scope") agent.companyId = "foreign";
    if (fault === "run-scope") run.agentId = "foreign";
    if (fault === "task-scope") run.issueId = "foreign";
    if (fault === "paused-agent") agent.status = "paused";
    if (fault === "paused-company") company.status = "paused";
    if (fault === "pause-reason") agent.pauseReason = "budget_unpriced";
    if (fault === "budget-changed") agent.budgetMonthlyCents = 0;
    if (fault === "pending") run.costAccountingPending = true;
    if (fault === "missing-settlement") delete run.costAccountedAt;
    if (fault === "missing-price") { usage.costUsd = null; usage.costUsdExact = null; }
    if (fault === "estimated") usage.costStatus = "estimated";
    if (fault === "partial") usage.costStatus = "unpriced";
    if (fault === "wrong-biller") usage.biller = "openai";
    if (fault === "wrong-provenance") usage.pricingProvenance = { source: "model_prices" };
    if (fault === "mismatched-exact") usage.costUsdExact = "0.040000000";
    if (fault === "unknown-tokens") delete usage.inputTokens;
    const paths: string[] = [];
    const receipt = await captureHermesOpenRouterSettlement({ companyId: "company", agentId: "agent", issueId: "task", runId: "run",
      ...(["cancelled", "cancelled-pending", "failed-cancellation"].includes(fault) ? { expectedRunStatus: "cancelled" as const } : {}), api: {
      async get<T>(url: string) { paths.push(url); return (url === "/api/companies/company" ? company : url === "/api/agents/agent" ? agent : run) as T; },
    } });
    expect(new Set(paths)).toEqual(new Set(["/api/companies/company", "/api/agents/agent", "/api/heartbeat-runs/run"]));
    expect(receipt.checks.every(check => check.passed)).toBe(["valid", "reported-zero", "cancelled"].includes(fault));
  });
  it.each(["valid", "missing", "duplicate", "company", "provider", "method", "ownership", "status", "owner", "caller"])("establishes the expected user from public account readback: %s", async fault => {
    const account = { id: "account", companyId: "company", provider: "xai", method: "api_key", ownership: "personal", ownerUserId: "user", status: "connected" };
    if (fault === "company") account.companyId = "foreign";
    if (fault === "provider") account.provider = "foreign";
    if (fault === "method") account.method = "foreign";
    if (fault === "ownership") account.ownership = "foreign";
    if (fault === "status") account.status = "foreign";
    if (fault === "owner") account.ownerUserId = "foreign";
    const receipt = await captureHermesApiAccountOwner({ companyId: "company", connectionId: "account", provider: "xai", api: {
      async get<T>(url: string) {
        expect(url).toBe("/api/companies/company/ai-connections");
        return { currentUserId: fault === "caller" ? "" : "user", connections: fault === "missing" ? [] : fault === "duplicate" ? [account, account] : [account] } as T;
      },
    } });
    expect(receipt.checks.every(check => check.passed)).toBe(fault === "valid");
    if (fault === "valid") expect(receipt.expectedResponsibleUserId).toBe("user");
  });
  it.each(["valid", "company-budget", "agent-budget", "company-scope", "agent-scope", "agent-company"])("checks %s through public budget readback before a paid task", async fault => {
    const company = { id: "company", budgetMonthlyCents: fault === "company-budget" ? 0 : 200 };
    const agent = { id: "agent", companyId: "company", budgetMonthlyCents: fault === "agent-budget" ? 0 : 200 };
    if (fault === "company-scope") company.id = "foreign";
    if (fault === "agent-scope") agent.id = "foreign";
    if (fault === "agent-company") agent.companyId = "foreign";
    const paths: string[] = [];
    const receipt = await captureHermesApiBudgets({ companyId: "company", agentId: "agent", api: {
      async get<T>(url: string) { paths.push(url); return (url === "/api/companies/company" ? company : agent) as T; },
    } });
    expect(new Set(paths)).toEqual(new Set(["/api/companies/company", "/api/agents/agent"]));
    expect(receipt.checks.every(check => check.passed)).toBe(fault === "valid");
  });
  it.each(["company", "task", "account", "provider", "method", "user", "consistent-foreign-user", "missing-expected-user", "model", "harness", "missing", "extra-run"])("rejects %s evidence even with a successful answer", fault => {
    const wrong = structuredClone(valid), run = wrong.runs[0]!;
    if (fault === "company") run.companyId = "foreign";
    if (fault === "task") run.issueId = "foreign";
    if (fault === "account") run.contextSnapshot.aiConnection.connectionId = "foreign";
    if (fault === "provider") run.contextSnapshot.aiConnection.provider = "openai";
    if (fault === "method") run.contextSnapshot.aiConnection.method = "subscription";
    if (fault === "user") run.contextSnapshot.aiConnection.responsibleUserId = "foreign";
    if (fault === "consistent-foreign-user") { run.responsibleUserId = "foreign"; run.contextSnapshot.aiConnection.responsibleUserId = "foreign"; }
    if (fault === "missing-expected-user") wrong.expectedResponsibleUserId = "";
    if (fault === "model") run.runnerProfileJson.sessionCheckpoint.providerIdentity.effectiveModel = "foreign";
    if (fault === "harness") run.runnerProfileJson.nativeExecutionInput.provider.agent = "codex";
    if (fault === "missing") wrong.runs = [];
    if (fault === "extra-run") wrong.runs.push(structuredClone(run));
    expect(gradeHermesApiConnection(wrong).some(check => !check.passed)).toBe(true);
  });
});
