import { createHash } from "node:crypto";

export interface BootstrapReadNotice {
  runId: string; sessionId: string; turnId: string; toolCallId: string; seq: number;
  stage: string; operation?: string; status?: string; readTargetSha256?: string;
}
export interface BootstrapReadProof { actionFile: string; events: readonly unknown[] }
const record = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const hashId = (domain: string, id: string) => `acpx-tool-${createHash("sha256").update(domain).update("tool\0").update(id).digest("hex")}`;
/** These native Product fixtures require runnerd (harness-env.ts), whose
 * cli/acpx-runtime-sidecar.ts stableProviderIdentity feeds runner-core's
 * provider_events.rs acpx_opaque_item_id. Durable tool execution IDs keep that
 * hash; the separate in-process TypeScript driver's safeId replacement is not
 * this path. Mirror the sidecar byte bound followed by the Rust opaque ID. */
export function bootstrapReadExecutionId(toolCallId: string): string {
  if (!toolCallId || toolCallId.length > 240 || /[\u0000-\u001f\u007f]/u.test(toolCallId) || toolCallId.includes("[REDACTED]")) throw new Error("Invalid bootstrap native tool identity");
  const bounded = Buffer.byteLength(toolCallId) > 240 ? hashId("paperclip.acpx.provider-identity.v1\0", toolCallId) : toolCallId;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(bounded) && Buffer.byteLength(bounded) <= 160 ? bounded : hashId("paperclip.acpx.opaque-item.v1\0", bounded);
}

/** Exempt only completed reads with the exact single-path native attestation on
 * every notice. Canonical PRP retains only the first location and may omit path
 * and kind on update, so it cannot establish single-file provenance by itself.
 * Validate its correlated lifecycle and reject every conflicting explicit path;
 * the passive origin attestation supplies cardinality and retained path proof.
 * No target is inferred from titles, output, or the first location alone. */
export function withoutProvenBootstrapReads<T extends BootstrapReadNotice>(
  notices: readonly T[], origin: BootstrapReadNotice, proof?: BootstrapReadProof,
): T[] {
  if (!proof) return [...notices];
  const expectedReadDigest = `sha256:${createHash("sha256").update(proof.actionFile).digest("hex")}`;
  const invalid = () => new Error("Native bootstrap read lacks exact complete action-file proof");
  if (notices.length > 2048 || proof.events.length > 20_000 || !/^\.paperclip-eval-action-[a-f0-9]{36}\.txt$/u.test(proof.actionFile) || !Number.isSafeInteger(origin.seq)) throw invalid();
  const candidates = notices.filter(n => n.operation === "read" && n.seq < origin.seq);
  const groups = new Map<string, T[]>();
  const nativeIds = new Map<string, string>();
  const noticeSeq = new Set<number>();
  for (const n of candidates) {
    if (n.readTargetSha256 !== expectedReadDigest || n.stage !== "tool" || n.runId !== origin.runId || n.turnId !== origin.turnId || n.sessionId !== origin.sessionId
      || !Number.isSafeInteger(n.seq) || n.seq < 0 || noticeSeq.has(n.seq)) throw invalid();
    noticeSeq.add(n.seq);
    const executionId = bootstrapReadExecutionId(n.toolCallId);
    if (nativeIds.has(executionId) && nativeIds.get(executionId) !== n.toolCallId) throw invalid();
    nativeIds.set(executionId, n.toolCallId);
    const group = groups.get(executionId) ?? []; group.push(n); groups.set(executionId, group);
  }
  const receipts = new Map<string, Array<{ seq: number; type: string; status: string; operation: string }>>();
  const receiptSeq = new Set<number>();
  for (const value of proof.events) {
    const row = record(value), event = record(record(row.payload).prpEvent), payload = record(event.payload);
    const type = row.eventType;
    const family = typeof type === "string" && type.startsWith("tool.execution.");
    const correlated = groups.has(payload.executionId);
    // An earlier canonical read without its native origin must not disappear.
    const earlierRead = family && payload.operation === "read" && row.seq < origin.seq;
    if (!correlated && !earlierRead) continue;
    if (!family || !["tool.execution.started", "tool.execution.progressed", "tool.execution.completed"].includes(type)
      || row.runId !== origin.runId || row.protocolSchemaVersion !== 1 || event.schema !== "paperclip.prp.event.v1"
      || event.schemaVersion !== 1 || event.sourceKind !== "runner" || event.runId !== origin.runId || event.turnId !== origin.turnId
      || event.eventType !== type || !Number.isFinite(Date.parse(event.emittedAt))
      || payload.schema !== "paperclip.tool.execution.v1" || payload.transport !== "builtin" || !["read", "unknown"].includes(payload.operation)
      || (payload.target !== null && payload.target !== proof.actionFile) || !groups.has(payload.executionId)
      || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.seq >= origin.seq || receiptSeq.has(row.seq) || noticeSeq.has(row.seq)) throw invalid();
    receiptSeq.add(row.seq);
    const group = receipts.get(payload.executionId) ?? [];
    group.push({ seq: row.seq, type, status: payload.status, operation: payload.operation }); receipts.set(payload.executionId, group);
  }
  for (const [id, native] of groups) {
    const canonical = receipts.get(id) ?? [];
    native.sort((a, b) => a.seq - b.seq); canonical.sort((a, b) => a.seq - b.seq);
    if (canonical.length < native.length || canonical.length === 0) throw invalid();
    for (let index = 0; index < native.length; index++) {
      const n = native[index]!;
      const terminal = n.status === "completed" || n.status === "failed";
      if ((!terminal && n.status !== "pending" && n.status !== "in_progress") || (terminal && index !== native.length - 1)) throw invalid();
    }
    if (!["completed", "failed"].includes(native.at(-1)!.status ?? "")) throw invalid();
    for (let index = 0; index < canonical.length; index++) {
      const c = canonical[index]!, last = index === canonical.length - 1;
      if ((index === 0 && c.operation !== "read")
        || (last ? c.type !== "tool.execution.completed" || c.status !== native.at(-1)!.status
          : c.status !== "running" || c.type !== (index === 0 ? "tool.execution.started" : "tool.execution.progressed"))) throw invalid();
    }
    // Native shape/content updates may omit status. PRP emits a progressed row
    // while the passive observer retains its attestation without another notice.
    // Such rows remain subject to exact identity, target, order and terminal checks.
    // Any later notice for this origin means the supposed bootstrap was not
    // complete before the tested action, even if an earlier terminal existed.
    if (notices.some(n => n.toolCallId === native[0]!.toolCallId && !native.includes(n))) throw invalid();
  }
  const exempt = new Set(candidates);
  return notices.filter(n => !exempt.has(n));
}
