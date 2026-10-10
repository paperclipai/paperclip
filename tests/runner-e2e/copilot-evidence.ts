/** Strict reader for bounded notices persisted through the public run-event API. */
export interface CopilotToolNotice {
  runId: string; sessionId: string; turnId: string; toolCallId: string;
  observedAtMs: number; seq: number;
  semanticOperationId?: string; semanticCallIdentitySha256?: string; semanticInputSha256?: string; semanticNormalizedInputSha256?: string | null; semanticResultSha256?: string; semanticOutcome?: "returned" | "error";
  stage: "tool" | "permission_requested" | "permission_delivered";
  status?: "pending" | "in_progress" | "completed" | "failed";
  operation?: "edit" | "execute" | "read"; target?: string; requestId?: string;
  declineOffered?: boolean; outcome?: "allow_once" | "allow_always" | "reject_once" | "cancel";
  commandSha256?: string; readTargetSha256?: string; mode?: "sync" | "async"; detach?: boolean;
  shellId?: string; commandToolCallId?: string; shellState?: "started" | "completed"; exitCode?: number;
}
const rec = (v: unknown): Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(v) && !v.includes("[REDACTED]");
const enums = { stage: ["tool", "permission_requested", "permission_delivered"], status: ["pending", "in_progress", "completed", "failed"], operation: ["edit", "execute", "read"], outcome: ["allow_once", "allow_always", "reject_once", "cancel"], mode: ["sync", "async"], shellState: ["started", "completed"] };
const names = new Set(["stage", "toolCallId", "status", "operation", "target", "requestId", "declineOffered", "outcome", "commandSha256", "readTargetSha256", "mode", "detach", "shellId", "commandToolCallId", "shellState", "exitCode", "semanticOperationId", "semanticCallIdentitySha256", "semanticInputSha256", "semanticNormalizedInputSha256", "semanticResultSha256", "semanticOutcome"]);
export function readCopilotToolEvidence(rows: readonly unknown[], expectedRunId: string): CopilotToolNotice[] {
  const result: CopilotToolNotice[] = [];
  for (const row of rows) {
    const r = rec(row), envelope = rec(rec(r.payload).prpEvent), p = rec(envelope.payload);
    if (r.eventType !== "provider.notice.recorded" || p.category !== "copilot_tool_evidence_v1") continue;
    const origin = rec(p.provenance);
    if (p.schema !== "paperclip.provider.notice.v1" || p.scope !== "turn" || envelope.schema !== "paperclip.prp.event.v1" || envelope.sourceKind !== "runner" || envelope.eventType !== r.eventType || envelope.runId !== expectedRunId || !id(origin.sessionId) || !id(origin.turnId) || origin.turnId !== envelope.turnId || !Array.isArray(p.details) || p.details.length > 20 || !Number.isSafeInteger(r.seq)) throw new Error("Invalid Copilot evidence binding");
    const fields: Record<string, string> = {};
    for (const detail of p.details) {
      const d = rec(detail);
      if (d.name === "stage" && d.value === "evidence_incomplete") throw new Error("Copilot evidence is explicitly incomplete");
      if (!names.has(d.name) || Object.hasOwn(fields, d.name) || typeof d.value !== "string" || d.value.length > 1024 || d.value.includes("[REDACTED]")) throw new Error("Invalid Copilot evidence detail");
      fields[d.name] = d.value;
    }
    if (!id(fields.toolCallId) || !enums.stage.includes(fields.stage!) || origin.eventType !== fields.stage || origin.method !== (fields.stage === "tool" ? "session/update" : "session/request_permission")) throw new Error("Invalid Copilot evidence origin");
    const observedAtMs = Date.parse(envelope.emittedAt);
    if (!Number.isFinite(observedAtMs)) throw new Error("Copilot evidence has no producer timestamp");
    const notice: Record<string, unknown> = { runId: expectedRunId, sessionId: origin.sessionId, turnId: origin.turnId, toolCallId: fields.toolCallId, stage: fields.stage, observedAtMs, seq: r.seq };
    for (const [key, choices] of Object.entries(enums)) if (fields[key] !== undefined) { if (!(choices as readonly string[]).includes(fields[key]!)) throw new Error("Invalid Copilot evidence enum"); notice[key] = fields[key]; }
    for (const key of ["requestId", "commandToolCallId"]) if (fields[key] !== undefined) { if (!id(fields[key])) throw new Error("Invalid Copilot evidence identity"); notice[key] = fields[key]; }
    for (const key of ["detach", "declineOffered"]) if (fields[key] !== undefined) { if (!["true", "false"].includes(fields[key]!)) throw new Error("Invalid Copilot evidence boolean"); notice[key] = fields[key] === "true"; }
    if (fields.target !== undefined) {
      if (!fields.target || fields.target.startsWith("/") || /[\\:\u0000-\u001f\u007f]/u.test(fields.target) || fields.target.split("/").some(x => x === "." || x === ".." || !x)) throw new Error("Invalid Copilot evidence target");
      notice.target = fields.target;
    }
    if (fields.readTargetSha256 !== undefined) { if (!/^sha256:[a-f0-9]{64}$/u.test(fields.readTargetSha256)) throw new Error("Invalid read digest"); notice.readTargetSha256 = fields.readTargetSha256; }
    if (fields.commandSha256 !== undefined) { if (!/^sha256:[a-f0-9]{64}$/u.test(fields.commandSha256)) throw new Error("Invalid command digest"); notice.commandSha256 = fields.commandSha256; }
    if (fields.shellId !== undefined) { if (!/^[A-Za-z0-9_.-]{1,80}$/u.test(fields.shellId)) throw new Error("Invalid shell identity"); notice.shellId = fields.shellId; }
    if (fields.exitCode !== undefined) { if (!/^-?\d{1,10}$/u.test(fields.exitCode) || !Number.isSafeInteger(Number(fields.exitCode))) throw new Error("Invalid exit code"); notice.exitCode = Number(fields.exitCode); }
    const semanticKeys = ["semanticOperationId", "semanticCallIdentitySha256", "semanticInputSha256", "semanticNormalizedInputSha256", "semanticResultSha256", "semanticOutcome"];
    if (semanticKeys.some(k => fields[k] !== undefined)) {
      if (!semanticKeys.every(k => fields[k] !== undefined) || fields.stage !== "tool" || !["completed", "failed"].includes(fields.status!)
        || !/^[A-Za-z0-9_.:-]{1,256}$/.test(fields.semanticOperationId!) || !["returned", "error"].includes(fields.semanticOutcome!)
        || ["semanticCallIdentitySha256", "semanticInputSha256", "semanticResultSha256"].some(k => !/^[a-f0-9]{64}$/.test(fields[k]!))) throw new Error("Invalid semantic receipt fields");
      if (fields.semanticNormalizedInputSha256 !== "null" && !/^[a-f0-9]{64}$/.test(fields.semanticNormalizedInputSha256!)) throw new Error("Invalid normalized semantic digest");
      for (const key of semanticKeys) notice[key] = fields[key];
      notice.semanticNormalizedInputSha256 = fields.semanticNormalizedInputSha256 === "null" ? null : fields.semanticNormalizedInputSha256;
    }
    result.push(notice as unknown as CopilotToolNotice);
  }
  return result;
}

export function copilotOrigin(n: CopilotToolNotice) {
  return { runId: n.runId, sessionId: n.sessionId, turnId: n.turnId, toolCallId: n.toolCallId };
}
