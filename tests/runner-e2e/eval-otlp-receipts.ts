import { EVAL_OTLP_LIMITS } from "./eval-otlp-relay.js";

export interface EvalOtlpReceiptPolicy {
  projectId: string; campaignId: string; attemptId: string; deadlineAt: string; expectedParent: string;
  limits: { [K in keyof typeof EVAL_OTLP_LIMITS]: number };
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  === JSON.stringify(b, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function inspectEvalOtlpReceipts(bytes: Buffer, expected: EvalOtlpReceiptPolicy) {
  if (bytes.length > 2_097_152 || !bytes.length || bytes[bytes.length - 1] !== 10) throw new Error("Incomplete OTLP receipts");
  const rows = bytes.toString("utf8").trimEnd().split("\n").map(line => {
    if (Buffer.byteLength(line) > 8192) throw new Error("Oversized OTLP receipt");
    const row = JSON.parse(line);
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid OTLP receipt");
    return row;
  });
  const policy = rows.shift(), closed = rows.pop();
  const opened = Date.parse(policy?.openedAt), deadline = Date.parse(expected.deadlineAt);
  if (!equal(policy, { type: "policy", version: 2, sizing: "otlp-v1.9-expanded-source-json", ...expected, openedAt: policy?.openedAt })
      || !Number.isFinite(opened) || !Number.isFinite(deadline) || opened >= deadline
      || closed?.type !== "closed" || !Number.isFinite(Date.parse(closed.at)) || Date.parse(closed.at) < opened) throw new Error("OTLP receipt policy or closure mismatch");
  const usage = { admittedRequests: 0, admittedWireBytes: 0, admittedBytes: 0, admittedExpandedBytes: 0,
    admittedRecords: 0, attemptedForwardBytes: 0, acceptedRequests: 0, incompleteRequests: 0 };
  const signals = { logs: { requests: 0, records: 0 }, traces: { requests: 0, records: 0 } };
  const requests = new Map<string, { bodyBytes: number; recordCount: number; signal: keyof typeof signals; finished: boolean }>();
  let quotaExhausted = false, pending = 0;
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < opened || at > Date.parse(closed.at)) throw new Error("Invalid OTLP receipt time");
    if (row.type === "quota_exhausted") {
      if (quotaExhausted || Object.keys(usage).some(key => !integer(row[key]) || row[key] > closed[key])) throw new Error("Invalid OTLP quota receipt");
      quotaExhausted = true;
    } else if (row.type === "admitted") {
      if (at >= deadline || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.id) || requests.has(row.id)
          || !["logs", "traces"].includes(row.signal) || !/^[a-f0-9]{64}$/.test(row.payloadSha256)
          || ![row.wireBytes, row.bodyBytes, row.expandedBytes, row.recordCount].every(integer)
          || row.wireBytes > expected.limits.maxRequestBytes || row.bodyBytes > expected.limits.maxRequestBytes
          || ++pending > expected.limits.maxConcurrent) throw new Error("Invalid OTLP admission receipt");
      requests.set(row.id, { bodyBytes: row.bodyBytes, recordCount: row.recordCount, signal: row.signal, finished: false });
      usage.admittedRequests++; usage.admittedWireBytes += row.wireBytes; usage.admittedBytes += row.bodyBytes;
      usage.admittedExpandedBytes += row.expandedBytes; usage.admittedRecords += row.recordCount;
      if (usage.admittedRequests > expected.limits.maxRequests || usage.admittedBytes > expected.limits.maxTotalBytes
          || usage.admittedExpandedBytes > expected.limits.maxExpandedBytes || usage.admittedRecords > expected.limits.maxRecords) throw new Error("OTLP receipts exceed allocation");
    } else if (row.type === "outcome") {
      const request = requests.get(row.id);
      if (!request || request.finished || !["accepted", "partial", "rejected", "uncertain", "not_dispatched"].includes(row.outcome)
          || typeof row.dispatched !== "boolean" || (row.outcome === "not_dispatched") !== !row.dispatched
          || row.httpStatus !== undefined && (!integer(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599)
          || row.rejectedRecords !== undefined && !integer(row.rejectedRecords)
          || ["accepted", "partial"].includes(row.outcome) && (!integer(row.rejectedRecords) || row.httpStatus < 200 || row.httpStatus >= 300 || row.httpStatus === undefined
            || (row.outcome === "accepted") !== (row.rejectedRecords === 0))) throw new Error("Invalid OTLP outcome receipt");
      request.finished = true; pending--;
      if (row.dispatched) usage.attemptedForwardBytes += request.bodyBytes;
      if (row.outcome === "accepted") {
        usage.acceptedRequests++; signals[request.signal].requests++; signals[request.signal].records += request.recordCount;
      } else usage.incompleteRequests++;
    } else throw new Error("Unknown OTLP receipt");
  }
  if (pending || closed.poisoned !== false || Object.entries(usage).some(([key, value]) => closed[key] !== value)) throw new Error("Unfinished or inconsistent OTLP receipts");
  return { ...usage, signals, quotaExhausted, status: quotaExhausted || usage.incompleteRequests ? "incomplete" : usage.admittedRecords ? "accepted" : "empty",
    verification: "unverified" as const };
}
