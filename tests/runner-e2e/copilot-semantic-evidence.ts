import { createHash } from "node:crypto";
import { readCopilotToolEvidence, type CopilotToolNotice } from "./copilot-evidence.js";

type Row = Record<string, any>;
const rec = (v: unknown): Row => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object"
  ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`).join(",")}}` : JSON.stringify(v) ?? "undefined";
const digest = (v: unknown) => hash(canonical(v));
const receiptKeys = ["callIdentitySha256", "inputSha256", "normalizedInputSha256", "operationId", "outcome", "resultSha256", "schema", "stage"].sort().join(",");
export interface CopilotSemanticCompletionProof {
  schema: "paperclip.e2e.copilot-semantic-completion.v2";
  runId: string; turnId: string; nativeSessionId: string; normalizedSessionId: string; sourceInstanceId: string;
  nativeToolCallId: string; callIdentitySha256: string; inputSha256: string; normalizedInputSha256: string; resultSha256: string;
  proposedSeq: number; receiptSeq: number; nativeCompletedSeq: number; turnCompletedSeq: number; acceptedSeq: number;
  summarySha256: string;
}
/** Independent public-event oracle. A transport receipt alone never proves completion acceptance. */
export function readCopilotSemanticCompletion(rows: readonly unknown[], expected: {
  companyId: string; runId: string; turnId: string; nativeSessionId: string; command: CopilotToolNotice; summary: string;
}): CopilotSemanticCompletionProof {
  const fail = (message: string): never => { throw new Error(`Copilot semantic completion: ${message}`); };
  const all = rows.map(rec), notices = readCopilotToolEvidence(rows, expected.runId);
  const commandRows = all.filter(r => r.seq === expected.command.seq);
  if (commandRows.length !== 1) fail("missing exact command origin");
  const base = rec(rec(commandRows[0]!.payload).prpEvent);
  if (!id(base.normalizedSessionId) || !id(base.sourceInstanceId)) fail("missing command stream");
  function frame(r: Row, sourceKind: "runner" | "control_plane") {
    const e = rec(rec(r.payload).prpEvent);
    if (r.companyId !== expected.companyId || r.runId !== expected.runId || !Number.isSafeInteger(r.seq) || r.seq < 1
      || e.schema !== "paperclip.prp.event.v1" || e.eventType !== r.eventType || e.sourceKind !== sourceKind
      || e.runId !== expected.runId || e.turnId !== expected.turnId || e.normalizedSessionId !== base.normalizedSessionId
      || !id(e.sourceInstanceId) || r.sourceInstanceId !== e.sourceInstanceId || r.sourceSeq !== e.sourceSeq
      || !Number.isSafeInteger(e.sourceSeq) || e.sourceSeq < 1
      || (sourceKind === "runner" && e.sourceInstanceId !== base.sourceInstanceId)) fail("foreign or malformed durable frame");
    return e;
  }
  frame(commandRows[0]!, "runner");
  // Every operation admitted later must belong to this durable stream, including
  // shell reads whose command identity is only known on their terminal notice.
  for (const n of notices) {
    const rs = all.filter(r => r.seq === n.seq);
    if (rs.length !== 1) fail("duplicate native row");
    frame(rs[0]!, "runner");
  }
  if (expected.command.runId !== expected.runId || expected.command.turnId !== expected.turnId || expected.command.sessionId !== expected.nativeSessionId) fail("foreign command");
  const authorityRows = all.filter(r => rec(rec(rec(r.payload).prpEvent).payload).category === "paperclip_semantic_tool_receipt_v2" || rec(rec(rec(r.payload).prpEvent).payload).category === "paperclip_semantic_tool_receipt_v1");
  // This authored case asks for one finish, not arbitrary semantic actions.
  if (authorityRows.length !== 1) fail("expected one authoritative finish receipt");
  const authorityRow = authorityRows[0]!, authority = frame(authorityRow, "runner"), payload = rec(authority.payload), origin = rec(payload.provenance);
  if (payload.category !== "paperclip_semantic_tool_receipt_v2" || payload.schema !== "paperclip.provider.notice.v1" || payload.scope !== "turn" || authorityRow.eventType !== "provider.notice.recorded"
    || origin.method !== "paperclip/semantic_tool_result" || origin.eventType !== "semantic_result"
    || origin.sessionId !== expected.nativeSessionId || origin.turnId !== expected.turnId || !Array.isArray(payload.details) || payload.details.length !== 8) fail("invalid receipt provenance");
  const fields: Record<string, string> = {};
  for (const d of payload.details) {
    if (Object.keys(rec(d)).sort().join(",") !== "name,value" || typeof d.name !== "string" || typeof d.value !== "string" || d.value.length > 256 || Object.hasOwn(fields, d.name)) fail("malformed receipt detail");
    fields[d.name] = d.value;
  }
  if (Object.keys(fields).sort().join(",") !== receiptKeys || fields.stage !== "semantic_result" || fields.schema !== "paperclip.semantic_tool_receipt.v2"
    || fields.operationId !== "paperclip_finish" || fields.outcome !== "returned"
    || ![fields.callIdentitySha256, fields.inputSha256, fields.normalizedInputSha256, fields.resultSha256].every(v => /^[a-f0-9]{64}$/.test(v!))) fail("invalid finish receipt");
  const matches = notices.filter(n => n.semanticCallIdentitySha256 === fields.callIdentitySha256);
  if (matches.length !== 1) fail("missing or duplicate native match");
  const native = matches[0]!;
  if (native.stage !== "tool" || native.status !== "completed" || native.sessionId !== expected.nativeSessionId || native.turnId !== expected.turnId
    || native.semanticOperationId !== fields.operationId || native.semanticInputSha256 !== fields.inputSha256 || native.semanticNormalizedInputSha256 !== fields.normalizedInputSha256 || native.semanticResultSha256 !== fields.resultSha256 || native.semanticOutcome !== "returned") fail("native receipt mismatch");
  const group = notices.filter(n => n.toolCallId === native.toolCallId);
  const pending = group.filter(n => n.stage === "tool" && n.status === "pending");
  if (pending.length !== 1 || group.filter(n => n.status === "completed" || n.status === "failed").length !== 1
    || group.some(n => n.stage !== "tool" || n.sessionId !== expected.nativeSessionId || n.turnId !== expected.turnId
      || n.operation !== undefined || n.target !== undefined || n.commandSha256 !== undefined || n.shellId !== undefined || n.commandToolCallId !== undefined
      || !["pending", "in_progress", "completed"].includes(n.status ?? "") || n.seq < pending[0]!.seq || n.seq > native.seq)) fail("not one semantic-only native lifecycle");
  for (const n of group) {
    const rs = all.filter(r => r.seq === n.seq); if (rs.length !== 1) fail("duplicate native row"); frame(rs[0]!, "runner");
  }
  const proposedRows = all.filter(r => r.eventType === "run.result.proposed"), acceptedRows = all.filter(r => r.eventType === "run.result.accepted"), terminals = all.filter(r => ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(r.eventType) && rec(rec(r.payload).prpEvent).turnId === expected.turnId);
  if (proposedRows.length !== 1 || acceptedRows.length !== 1 || terminals.length !== 1 || terminals[0]!.eventType !== "turn.completed"
    || all.some(r => r.eventType === "run.result.rejected")) fail("missing, rejected or ambiguous completion");
  const proposed = frame(proposedRows[0]!, "runner"), accepted = frame(acceptedRows[0]!, "control_plane"), terminal = frame(terminals[0]!, "runner");
  const result = rec(proposed.payload), acceptedResult = rec(rec(accepted.payload).result);
  // Native correlation uses the invocation-captured callback call hash. The
  // canonical proposal itemId may instead identify the run: never interpret it
  // as a bridge call ID. Unique same-turn result bodies supply the independent
  // acceptance proof, joined to the normalized digest captured by the same
  // invocation after validation. Raw provider arguments may omit defaults;
  // their separate digest remains joined to the native receipt above. Never
  // reconstruct or normalize a proposal here to make its digest match.
  if (digest(result) !== fields.normalizedInputSha256
    || result.schema !== "paperclip.run_result.v1" || result.reportedWorkDisposition !== "done" || result.summary !== expected.summary
    || canonical(result) !== canonical(acceptedResult)) fail("canonical accepted result does not match exact finish");
  const pendingFrame = frame(all.find(r => r.seq === pending[0]!.seq)!, "runner");
  const completedFrame = frame(all.find(r => r.seq === native.seq)!, "runner");
  if (!(expected.command.seq < pending[0]!.seq && pending[0]!.seq < proposedRows[0]!.seq && proposedRows[0]!.seq < authorityRow.seq
    && authorityRow.seq < native.seq && native.seq < terminals[0]!.seq && terminals[0]!.seq < acceptedRows[0]!.seq)
    || !(base.sourceSeq < pendingFrame.sourceSeq && pendingFrame.sourceSeq < proposed.sourceSeq && proposed.sourceSeq < authority.sourceSeq
      && authority.sourceSeq < completedFrame.sourceSeq && completedFrame.sourceSeq < terminal.sourceSeq)) fail("invalid causal order");
  return { schema: "paperclip.e2e.copilot-semantic-completion.v2", runId: expected.runId, turnId: expected.turnId, nativeSessionId: expected.nativeSessionId,
    normalizedSessionId: base.normalizedSessionId, sourceInstanceId: base.sourceInstanceId, nativeToolCallId: native.toolCallId,
    callIdentitySha256: fields.callIdentitySha256!, inputSha256: fields.inputSha256!, normalizedInputSha256: fields.normalizedInputSha256!, resultSha256: fields.resultSha256!,
    proposedSeq: proposedRows[0]!.seq, receiptSeq: authorityRow.seq, nativeCompletedSeq: native.seq, turnCompletedSeq: terminals[0]!.seq, acceptedSeq: acceptedRows[0]!.seq, summarySha256: hash(expected.summary) };
}

/** Called only after the completion proof and bootstrap-read oracle succeed. */
export function onlyCopilotAttachedOperations(notices: readonly CopilotToolNotice[], command: CopilotToolNotice, proof: CopilotSemanticCompletionProof): boolean {
  if (proof.runId !== command.runId || proof.turnId !== command.turnId || proof.nativeSessionId !== command.sessionId
    || proof.nativeToolCallId === command.toolCallId || notices.length > 2048
    || notices.some(n => n.runId !== command.runId || n.sessionId !== command.sessionId || n.turnId !== command.turnId
      || !Number.isSafeInteger(n.seq) || n.seq < 1 || n.seq >= proof.turnCompletedSeq)
    || new Set(notices.map(n => n.seq)).size !== notices.length) return false;
  const groups = new Map<string, CopilotToolNotice[]>();
  for (const n of notices) { const group = groups.get(n.toolCallId) ?? []; group.push(n); groups.set(n.toolCallId, group); }
  // Exactly one command, one shell-result read, and the already-proven finish.
  // A completed-only extra read cannot borrow the original command's identity.
  if (groups.size !== 3 || !groups.has(proof.nativeToolCallId)) return false;
  const complete = (group: CopilotToolNotice[]): boolean => {
    group.sort((a, b) => a.seq - b.seq);
    return group.length >= 2 && group[0]!.status === "pending" && group.at(-1)!.status === "completed"
      && group.every((n, i) => n.stage === "tool" && (i === 0 ? n.status === "pending"
        : i === group.length - 1 ? n.status === "completed" : n.status === "in_progress"));
  };
  const semanticFree = (n: CopilotToolNotice) => n.semanticOperationId === undefined && n.semanticCallIdentitySha256 === undefined
    && n.semanticInputSha256 === undefined && n.semanticNormalizedInputSha256 === undefined && n.semanticResultSha256 === undefined && n.semanticOutcome === undefined;
  const commandGroup = groups.get(command.toolCallId) ?? [];
  if (!complete(commandGroup) || commandGroup[0]!.seq !== command.seq) return false;
  const started = commandGroup.at(-1)!;
  if (!id(started.shellId) || started.shellState !== "started" || started.commandToolCallId !== command.toolCallId
    || commandGroup.some(n => n.operation !== "execute" || n.commandSha256 !== command.commandSha256 || n.mode !== "async" || n.detach !== false
      || n.target !== undefined || n.readTargetSha256 !== undefined || n.exitCode !== undefined || !semanticFree(n)
      || (n !== started && (n.shellId !== undefined || n.shellState !== undefined || n.commandToolCallId !== undefined)))) return false;
  const shellGroup = [...groups].find(([key]) => key !== command.toolCallId && key !== proof.nativeToolCallId)![1];
  if (!complete(shellGroup)) return false;
  const terminal = shellGroup.at(-1)!;
  return shellGroup[0]!.seq > started.seq && terminal.seq < proof.turnCompletedSeq
    && terminal.commandToolCallId === command.toolCallId && terminal.shellState === "completed" && terminal.exitCode === 0
    && shellGroup.every(n => n.operation === "read" && n.shellId === started.shellId && n.target === undefined && n.readTargetSha256 === undefined
      && n.commandSha256 === undefined && n.mode === undefined && n.detach === undefined && semanticFree(n)
      && (n === terminal || (n.commandToolCallId === undefined && n.shellState === undefined && n.exitCode === undefined)));
}
