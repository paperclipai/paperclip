import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { nativeSha256 } from "../../server/src/services/native-runtime/canonical.js";
import { REDACTED_EVENT_VALUE } from "../../server/src/redaction.js";
import { CASE_RECEIPT_BUDGET_CENTS, CASE_RECEIPT_MAX_TURNS, CASE_RECEIPT_RUN_TIMEOUT_MS, type CaseReceiptAgents } from "./case-receipt-cases.js";

type Row = Record<string, any>;
export interface CaseReceiptObservation {
  nonce: string; companyId: string; taskId: string; caseId: string; agents: CaseReceiptAgents;
  issue: Row; caseRecord: Row; cases: Row[]; tasks: Row[]; handoffs: Row[]; runs: Row[];
  receipt: Row | null; receiptRevisions: Row[]; review: Row | null;
  initialBrief?: Row | null; triageReadBrief?: boolean;
  handoffToolRunIds: string[]; verifierReadReceipt: boolean; builderReadReview: boolean; kickoffReplayed: boolean;
  pendingInteractions: number;
  budgets?: { company: Row; agents: Row[] };
  configuredLimits?: { maxRuns: number; runTimeoutMs: number; attemptTimeoutMs: number; automaticRetryPolicy?: string; agents: Row[] };
}

const object = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const document = (value: unknown) => { const row = object(value); return object(row.document ?? row); };
const body = (value: unknown) => {
  const row = document(value);
  try { return typeof (row.body ?? row.latestBody) === "string" ? JSON.parse(row.body ?? row.latestBody) : null; } catch { return null; }
};
const timestamp = (value: unknown) => typeof value === "string" || value instanceof Date ? Date.parse(String(value)) : NaN;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const keys = (value: unknown, expected: string[]) => {
  const actual = Object.keys(object(value)).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
};
const initialReceipt = (value: unknown) => keys(value, ["total"]) && object(value).total === 6;
const finalReceipt = (value: unknown) => keys(value, ["total", "currency"]) && object(value).total === 6 && object(value).currency === "USD";
const expectedReview = (value: unknown) => keys(value, ["totalCorrect", "missing"]) && object(value).totalCorrect === true
  && Array.isArray(object(value).missing) && object(value).missing.length === 1 && object(value).missing[0] === "currency";

/** Ordinary native document tools are scoped to the admitted task. The saved
 * result must identify that task, document and revision, and correlate with a
 * successful runner execution. Model prose cannot establish a persisted read. */
export function hasTaskDocumentRead(events: readonly Row[], taskId: string, key: string, requireBeforeDocumentWrite = false): boolean {
  const name = (value: unknown) => typeof value === "string" ? value.split(".").at(-1) : undefined;
  const valid = events.flatMap(event => {
    const envelope = object(event.payload).prpEvent;
    return envelope?.sourceKind === "runner" && isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion)
      && integer(event.seq) ? [{ event, payload: object(envelope.payload) }] : [];
  });
  const savedDocument = (result: unknown) => {
    const value = object(result);
    return object(object(value.result ?? value).document);
  };
  const persisted = (saved: Row) => saved.issueId === taskId && id(saved.id) && id(saved.latestRevisionId)
    && integer(saved.latestRevisionNumber) && saved.latestRevisionNumber > 0;
  const completed = (callId: string, tool: string, after: number, before = Infinity) => valid.some(({ event, payload }) =>
    event.seq > after && event.seq < before && event.eventType === "tool.execution.completed"
    && name(payload.name) === tool && payload.executionId === callId && payload.status === "completed");
  const firstWrite = requireBeforeDocumentWrite ? valid.filter(({ event, payload }) => event.eventType === "item.started"
    && payload.item?.type === "tool_use" && name(payload.item.name) === "write_document")
    .sort((a, b) => a.event.seq - b.event.seq)[0] : undefined;
  if (requireBeforeDocumentWrite) {
    if (!firstWrite) return false;
    const item = object(firstWrite.payload.item), input = object(item.input);
    if (!id(item.id) || !id(input.key) || !completed(item.id, "write_document", firstWrite.event.seq)) return false;
    if (!valid.some(({ event, payload }) => {
      const returned = object(payload.item), saved = savedDocument(returned.result);
      return event.seq > firstWrite.event.seq && event.eventType === "item.completed" && returned.type === "tool_result"
        && returned.id === item.id && (returned.tool_use_id === undefined || returned.tool_use_id === item.id)
        && persisted(saved) && saved.key === input.key;
    })) return false;
  }
  return valid.some(({ event: start, payload }) => {
    const item = object(payload.item), input = object(item.input);
    if (start.eventType !== "item.started" || item.type !== "tool_use" || name(item.name) !== "read_document"
      || !id(item.id) || !keys(input, ["key"]) || input.key !== key
      || !completed(item.id, "read_document", start.seq, firstWrite?.event.seq)) return false;
    return valid.some(({ event, payload: returned }) => {
      const resultItem = object(returned.item), saved = savedDocument(resultItem.result);
      return event.seq > start.seq && (!firstWrite || event.seq < firstWrite.event.seq) && event.eventType === "item.completed"
        && resultItem.type === "tool_result" && resultItem.id === item.id
        && (resultItem.tool_use_id === undefined || resultItem.tool_use_id === item.id)
        && persisted(saved) && saved.key === key && typeof (saved.latestBody ?? saved.body) === "string";
    });
  });
}

/** Historical reader retained for immutable earlier case-document campaigns. */
export function hasCaseDocumentRead(events: readonly Row[], caseId: string, key: string, requireBeforeDocumentWrite = false): boolean {
  const operation = "GET /api/cases/{id}/documents/{key}";
  const toolName = (name: unknown) => typeof name === "string" ? name.split(".").at(-1) : undefined;
  const apiTool = (name: unknown) => toolName(name) === "call_api";
  const readTool = (name: unknown) => apiTool(name) || toolName(name) === "read_case_document";
  const writeTool = (name: unknown) => apiTool(name) || toolName(name) === "write_case_document";
  const expectedInput = { operationId: operation, pathParams: { id: caseId, key } };
  // Production history hides API parameters and bodies. Its canonical request
  // digest can still prove this exact public read without exposing the content.
  const inputHashes = new Set([nativeSha256(expectedInput), nativeSha256({ ...expectedInput, query: {} })]);
  const nativeInputHash = nativeSha256({ caseId, key });
  const receiptFields = new Set(["operationId", "apiOperationId", "callId", "ok", "status", "contentType", "data", "apiPayloadRedacted", "apiPayloadSha256"]);
  const redacted = (value: Row) => value.apiPayloadRedacted === true && value.data === REDACTED_EVENT_VALUE
    && typeof value.apiPayloadSha256 === "string" && /^[a-f0-9]{64}$/.test(value.apiPayloadSha256)
    && Object.keys(value).every(field => receiptFields.has(field));
  const hasRedaction = (value: Row) => "apiPayloadRedacted" in value || "apiPayloadSha256" in value;
  const valid = events.flatMap(event => {
    const envelope = object(event.payload).prpEvent;
    return envelope?.sourceKind === "runner" && isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion)
      && integer(event.seq) ? [{ event, payload: object(envelope.payload) }] : [];
  });
  const writeOperation = "PUT /api/cases/{id}/documents/{key}";
  const firstWrite = requireBeforeDocumentWrite ? valid.filter(({ event, payload }) => {
    const item = object(payload.item);
    return event.eventType === "item.started" && item.type === "tool_use" && writeTool(item.name)
      && (!apiTool(item.name) || object(item.input).operationId === writeOperation);
  }).sort((a, b) => a.event.seq - b.event.seq)[0] : undefined;
  if (requireBeforeDocumentWrite) {
    if (!firstWrite) return false;
    const item = object(firstWrite.payload.item), input = object(item.input);
    const writeParams = object(input.pathParams);
    const validInput = hasRedaction(input) ? redacted(input)
      : apiTool(item.name) ? id(writeParams.id) && id(writeParams.key) : id(input.caseId) && id(input.key);
    if (!id(item.id) || !validInput) return false;
    const completed = valid.some(({ event, payload }) => event.seq > firstWrite.event.seq
      && event.eventType === "tool.execution.completed" && toolName(payload.name) === toolName(item.name)
      && payload.executionId === item.id && payload.status === "completed");
    const succeeded = valid.some(({ event, payload }) => {
      const returned = object(payload.item), result = object(returned.result);
      const saved = object(result.data);
      const validResult = hasRedaction(result) ? redacted(result) : id(object(saved.document).id) && id(object(saved.revision).id);
      return event.seq > firstWrite.event.seq && event.eventType === "item.completed" && returned.type === "tool_result"
        && returned.id === item.id && (returned.tool_use_id === undefined || returned.tool_use_id === item.id)
        && result.ok === true && result.status === 200 && result.apiOperationId === writeOperation
        && validResult;
    });
    if (!completed || !succeeded) return false;
  }
  for (const { event: start, payload } of valid) {
    const item = object(payload.item), input = object(item.input), params = object(input.pathParams);
    const matchesInput = hasRedaction(input) ? redacted(input) && (apiTool(item.name)
      ? inputHashes.has(input.apiPayloadSha256) : input.apiPayloadSha256 === nativeInputHash)
      : apiTool(item.name) ? params.id === caseId && params.key === key
        : keys(input, ["caseId", "key"]) && input.caseId === caseId && input.key === key;
    if (start.eventType !== "item.started" || item.type !== "tool_use" || !readTool(item.name) || !id(item.id)
      || (apiTool(item.name) && input.operationId !== operation) || !matchesInput) continue;
    const completed = valid.some(({ event, payload: finished }) => event.seq > start.seq && event.eventType === "tool.execution.completed"
      && toolName(finished.name) === toolName(item.name) && finished.executionId === item.id && finished.status === "completed");
    if (!completed) continue;
    if (valid.some(({ event, payload: returned }) => {
      const resultItem = object(returned.item), result = object(resultItem.result), saved = object(result.data);
      const matchesResult = hasRedaction(result) ? redacted(result)
        : id(saved.id) && saved.key === key && id(saved.latestRevisionId) && typeof (saved.body ?? saved.latestBody) === "string";
      return event.seq > start.seq && event.eventType === "item.completed" && resultItem.type === "tool_result"
        && (!firstWrite || event.seq < firstWrite.event.seq)
        && resultItem.id === item.id && (resultItem.tool_use_id === undefined || resultItem.tool_use_id === item.id)
        && result.ok === true && result.status === 200 && result.apiOperationId === operation
        && matchesResult;
    })) return true;
  }
  return false;
}

export function gradeCaseReceipt(input: CaseReceiptObservation) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ id: name, passed, detail });
  const issue = object(input.issue), workflow = object(input.caseRecord), fields = object(workflow.fields);
  const tasks = Array.isArray(input.tasks) ? input.tasks : [], cases = Array.isArray(input.cases) ? input.cases : [];
  const runs = [...(Array.isArray(input.runs) ? input.runs : [])].sort((a, b) => timestamp(a.startedAt) - timestamp(b.startedAt));
  const handoffs = [...(Array.isArray(input.handoffs) ? input.handoffs : [])].sort((a, b) => a.version - b.version);
  const phases = ["triage", "implementation", "verification", "revision"];
  const agents = [input.agents?.triage, input.agents?.implementation, input.agents?.verification, input.agents?.implementation];
  const distinctAgents = [...new Set(agents)];
  const passives = cases.filter(row => row.id !== input.caseId);
  const listedWorkflow = cases.filter(row => row.id === input.caseId);
  add("one-primary-task-and-two-passive-cases", id(input.nonce) && distinctAgents.length === 3 && distinctAgents.every(id)
    && issue.id === input.taskId && issue.companyId === input.companyId && tasks.length === 1 && tasks[0]?.id === input.taskId
    && workflow.id === input.caseId && workflow.companyId === input.companyId && workflow.workIssueId === input.taskId
    && cases.length === 3 && new Set(cases.map(row => row.id)).size === 3 && listedWorkflow.length === 1
    && listedWorkflow[0]?.workIssueId === input.taskId && passives.length === 2
    && passives.every(row => row.companyId === input.companyId && row.caseType === "receipt-research" && row.workIssueId === null
      && row.phase === null && row.handoffVersion === 0 && row.fields?.nonce === input.nonce)
    && passives.map(row => row.status).sort().join(",") === "done,draft",
  "Exactly one company task and workflow case exist; the two draft/done research cases remain passive.");
  add("unchanged-receipt-inputs", fields.nonce === input.nonce && fields.currency === "USD" && Array.isArray(fields.items)
    && fields.items.length === 1 && keys(fields.items[0], ["quantity", "unitPrice"])
    && fields.items[0].quantity === 2 && fields.items[0].unitPrice === 3,
  "The persisted fixture inputs independently imply total 6 and currency USD.");
  add("triage-validation-persisted", fields.inputsValidated === true,
    "Triage saved its input validation through the native case update surface.");
  const brief = object(input.initialBrief);
  add("initial-task-brief-read", brief.issueId === input.taskId && brief.key === "brief" && brief.latestRevisionNumber === 1
    && (brief.latestBody ?? brief.body) === `Receipt ${input.nonce}: total and currency are required.` && input.triageReadBrief === true,
  "The initial brief belongs to the primary task and triage read its persisted revision through the ordinary native document tool.");
  const validRuns = runs.length === CASE_RECEIPT_MAX_TURNS && new Set(runs.map(run => run.id)).size === CASE_RECEIPT_MAX_TURNS
    && runs.every((run, index) => id(run.id) && run.companyId === input.companyId && run.agentId === agents[index]
      && run.runtimeMode === "native" && run.status === "succeeded"
      && [run.issueId, run.nativeIssueId, run.contextSnapshot?.issueId, run.contextSnapshot?.taskId].includes(input.taskId)
      && Number.isFinite(timestamp(run.startedAt)) && Number.isFinite(timestamp(run.finishedAt))
      && timestamp(run.finishedAt) >= timestamp(run.startedAt)
      && timestamp(run.finishedAt) - timestamp(run.startedAt) <= CASE_RECEIPT_RUN_TIMEOUT_MS
      && (index === 0 || timestamp(run.startedAt) >= timestamp(runs[index - 1]?.finishedAt)));
  add("four-settled-nonoverlapping-runs", validRuns,
    "Exactly four successful native task runs follow triage, builder, verifier, returning builder without overlap or an extra turn.");
  const validHandoffs = handoffs.length === 5 && new Set(handoffs.map(row => row.id)).size === 5
    && handoffs.slice(0, 4).every((row, index) => row.destinationKind === "agent" && id(row.id) && row.companyId === input.companyId && row.caseId === input.caseId
      && row.issueId === input.taskId && row.version === index + 1 && row.phase === phases[index] && row.toAgentId === agents[index]
      && row.state === "delivered" && integer(row.appliedIssueStatusVersion)
      && (index === 0 ? row.sourceRunId === null && (row.fromAgentId === null || row.fromAgentId === agents[0])
        : row.fromAgentId === agents[index - 1] && row.sourceRunId === runs[index - 1]?.id)
      && Number.isFinite(timestamp(row.assignmentAppliedAt)) && Number.isFinite(timestamp(row.deliveredAt))
      && timestamp(row.assignmentAppliedAt) <= timestamp(runs[index]?.startedAt)
      && timestamp(row.deliveredAt) >= timestamp(row.assignmentAppliedAt)
      && (index === 0 || timestamp(row.assignmentAppliedAt) >= timestamp(runs[index - 1]?.finishedAt)));
  add("same-task-ordered-handoffs", validRuns && validHandoffs,
    "Four delivered, run-attributed routing revisions keep the original task and wait for each outgoing run to finish.");
  const toolRuns = Array.isArray(input.handoffToolRunIds) ? input.handoffToolRunIds : [];
  add("native-handoff-receipts-and-kickoff-replay", input.kickoffReplayed === true && toolRuns.length === 4
    && new Set(toolRuns).size === 4 && runs.every(run => toolRuns.includes(run.id)) && validRuns && validHandoffs,
  "Kickoff replay preserved the receipt, and all agent transfers and the terminal handoff have completed native tool receipts.");
  add("fresh-phase-context", validRuns && validHandoffs && runs.every((run, index) => {
    const context = object(run.contextSnapshot?.paperclipCase);
    return context.id === input.caseId && context.taskId === input.taskId && context.phase === phases[index]
      && context.handoffVersion === index + 1 && integer(context.issueStatusVersion)
      && context.issueStatusVersion >= handoffs[index]!.appliedIssueStatusVersion
      && context.incomingHandoff?.id === handoffs[index]!.id
      && typeof context.incomingHandoff?.instructions === "string" && context.incomingHandoff.instructions.includes(input.nonce);
  }), "Every admitted run received its own current handoff ID, phase, routing version, and observed task version.");

  const receipt = document(input.receipt), review = document(input.review), reviewRevision = object(input.review?.revision);
  const revisions = [...(Array.isArray(input.receiptRevisions) ? input.receiptRevisions : [])].sort((a, b) => a.revisionNumber - b.revisionNumber);
  const inRun = (revision: Row, run: Row | undefined) => !!run && revision.createdByRunId === run.id
    && timestamp(revision.createdAt) >= timestamp(run.startedAt) && timestamp(revision.createdAt) <= timestamp(run.finishedAt);
  add("persisted-receipt-correction", validRuns && id(receipt.id) && receipt.companyId === input.companyId
    && receipt.createdByAgentId === input.agents.implementation && receipt.updatedByAgentId === input.agents.implementation
    && revisions.length === 2 && revisions.every((revision, index) => id(revision.id) && revision.revisionNumber === index + 1
      && revision.createdByAgentId === input.agents.implementation && revision.createdByUserId == null)
    && revisions[0]?.id !== revisions[1]?.id && inRun(revisions[0] ?? {}, runs[1]) && inRun(revisions[1] ?? {}, runs[3])
    && initialReceipt(body(revisions[0])) && finalReceipt(body(revisions[1])) && finalReceipt(body(receipt))
    && receipt.latestRevisionId === revisions[1]?.id && receipt.latestRevisionNumber === 2,
  "The first builder saved only total 6; the same returning builder revised that task document to total 6 and currency USD.");
  add("independent-persisted-review", validRuns && id(review.id) && review.id !== receipt.id && review.companyId === input.companyId
    && review.createdByAgentId === input.agents.verification && review.updatedByAgentId === input.agents.verification
    && review.latestRevisionId === reviewRevision.id && review.latestRevisionNumber === 1 && reviewRevision.revisionNumber === 1
    && id(reviewRevision.id) && reviewRevision.createdByAgentId === input.agents.verification && reviewRevision.createdByUserId == null
    && inRun(reviewRevision, runs[2]) && expectedReview(body(review)) && expectedReview(body(reviewRevision))
    && timestamp(revisions[0]?.createdAt) < timestamp(reviewRevision.createdAt)
    && timestamp(reviewRevision.createdAt) < timestamp(revisions[1]?.createdAt),
  "A separate verifier persisted the actual total comparison and missing currency before the returning builder corrected the receipt.");
  add("persisted-document-read-receipts", input.verifierReadReceipt === true && input.builderReadReview === true,
    "Correlated successful native API receipts prove the verifier read receipt and the returning builder read review.");
  const terminal = handoffs[4];
  add("explicit-terminal-case-completion", validRuns && validHandoffs && issue.status === "done"
    && issue.assigneeAgentId === input.agents.implementation && workflow.status === "done"
    && workflow.phase === "done" && workflow.handoffVersion === 5 && workflow.pendingHandoff == null
    && input.pendingInteractions === 0 && Number.isFinite(timestamp(workflow.completedAt))
    && terminal?.destinationKind === "done" && terminal.state === "completed" && terminal.phase === "done"
    && terminal.companyId === input.companyId && terminal.caseId === input.caseId && terminal.issueId === input.taskId
    && terminal.version === 5 && terminal.fromAgentId === input.agents.implementation && terminal.toAgentId === null
    && terminal.sourceRunId === runs[3]?.id && Number.isFinite(timestamp(terminal.completedAt))
    && timestamp(terminal.completedAt) === timestamp(workflow.completedAt)
    && timestamp(terminal.completedAt) >= timestamp(runs[3]?.startedAt)
    && timestamp(terminal.completedAt) <= timestamp(runs[3]?.finishedAt),
  "The returning builder explicitly handed off to done; accepted completion closed the same task and case without another run.");

  const limits = input.configuredLimits, budgets = input.budgets, roleLimits = [1, 2, 1];
  const persistedAgents = Array.isArray(limits?.agents) ? limits.agents : [], budgetAgents = Array.isArray(budgets?.agents) ? budgets.agents : [];
  add("configured-four-turn-budget", limits?.maxRuns === 4 && limits.runTimeoutMs === CASE_RECEIPT_RUN_TIMEOUT_MS
    && limits.attemptTimeoutMs === 5 * 60_000 && limits.automaticRetryPolicy === "single_attempt"
    && budgets?.company?.budgetMonthlyCents === CASE_RECEIPT_BUDGET_CENTS && budgetAgents.length === 3 && persistedAgents.length === 3
    && distinctAgents.every((agentId, index) => budgetAgents.filter(agent => agent.id === agentId && agent.budgetMonthlyCents === CASE_RECEIPT_BUDGET_CENTS).length === 1
      && persistedAgents.filter(agent => agent.id === agentId && agent.maxDailyRuns === roleLimits[index] && agent.maxConcurrentRuns === 1
        && agent.heartbeatEnabled === false && agent.timeoutSec === 90 && agent.modelReasoningEffort === "low").length === 1),
  "Public readback confirms 100-cent company/agent stops, role run caps 1/2/1, one concurrent run, low effort, 90-second turns, and one five-minute attempt.");
  return checks;
}
