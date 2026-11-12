import { nativeSha256 } from "../../../server/src/services/native-runtime/canonical.js";

/** The digest the port saves for a redacted call_api input (the server's own canonical SHA-256). */
export const callApiInputDigest = (input: Record<string, unknown>) => nativeSha256(input);

/**
 * Record-bound read receipts that survive run-event redaction.
 *
 * PaperclipControlPlanePort saves call_api inputs and results with their
 * payloads replaced by a SHA-256 digest; only the operationId, ok and status
 * remain. A read is therefore tied to a record by recomputing the digest of
 * every input that names it (path parameter by id or identifier, with no query
 * or a small paging query) and requiring the paired result to report the
 * expected status. The agent's own wording is never matched.
 */
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const PAGE_LIMITS = Array.from({ length: 1001 }, (_, index) => index).flatMap(limit => [{ limit }, { limit: String(limit) }]);
const cache = new Map<string, ReadonlySet<string>>();

export interface ApiRead {
  operationId: string;
  /** Each alternative names the record, e.g. [{ id: uuid }, { id: "COM-1" }]; `undefined` means the server fills the path. */
  pathParams: ReadonlyArray<Record<string, string> | undefined>;
  /** Accept a `limit` paging query (number or string, 0..1000) in addition to none. */
  paged?: boolean;
  /** Other accepted queries, e.g. a project filter. */
  queries?: ReadonlyArray<Record<string, unknown>>;
}

/** Digests of every accepted call_api input for these reads. */
export function apiReadDigests(reads: readonly ApiRead[]): ReadonlySet<string> {
  const key = JSON.stringify(reads);
  const cached = cache.get(key); if (cached) return cached;
  const digests = new Set<string>();
  for (const read of reads) {
    const queries: Array<Record<string, unknown> | undefined> = [undefined, {}, ...(read.paged ? PAGE_LIMITS : []), ...(read.queries ?? [])];
    for (const pathParams of read.pathParams) for (const query of queries) {
      digests.add(callApiInputDigest({ operationId: read.operationId, ...(pathParams ? { pathParams } : {}), ...(query ? { query } : {}) }));
      if (!pathParams) digests.add(callApiInputDigest({ operationId: read.operationId, pathParams: {}, ...(query ? { query } : {}) }));
    }
  }
  cache.set(key, digests);
  return digests;
}

/** Path parameter alternatives naming one record by id and, when known, its human identifier. */
export function recordParams(name: string, ...values: Array<string | null | undefined>): Array<Record<string, string>> {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].map(value => ({ [name]: value }));
}

/**
 * Dedicated task read tools and the call_api input the server builds for them
 * (taskBridgeApiRequest in paperclip-runner-tool-authority.ts). Their saved
 * tool_use keeps the plaintext taskId, while the result carries the same
 * redacted receipt (apiOperationId, ok, status) as call_api. Harnesses may
 * namespace the name (paperclip_get_task, mcp__paperclip__get_task).
 */
const TASK_READ_TOOLS: Readonly<Record<string, string>> = {
  get_task: "GET /api/issues/{id}",
  list_task_documents: "GET /api/issues/{id}/documents",
  read_task_document: "GET /api/issues/{id}/documents/{key}",
};
function taskReadTool(name: unknown): string | undefined {
  const match = typeof name === "string" ? /^(?:[A-Za-z0-9_-]*__)?(?:paperclip_)?([a-z_]+)$/.exec(name) : null;
  return match && Object.hasOwn(TASK_READ_TOOLS, match[1]!) ? match[1] : undefined;
}
function taskReadInput(tool: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof input.taskId !== "string" || !input.taskId) return;
  if (tool === "read_task_document" && (typeof input.key !== "string" || !input.key)) return;
  return { operationId: TASK_READ_TOOLS[tool], pathParams: { id: input.taskId, ...(tool === "read_task_document" ? { key: input.key } : {}) } };
}

/**
 * Statuses of this run's record reads whose input digest is one of `digests`,
 * paired to their tool_use by run and item id: call_api uses by their saved
 * digest, and dedicated task read tools by the digest of the call_api input
 * the server builds from their plaintext input.
 */
export function apiReadStatuses(events: readonly Record<string, unknown>[], digests: ReadonlySet<string>): Array<{ operationId: string; ok: boolean; status: number }> {
  const uses = new Map<string, string>();
  const statuses: Array<{ operationId: string; ok: boolean; status: number }> = [];
  for (const row of events) {
    const envelope = objectRecord(objectRecord(row.payload).prpEvent), item = objectRecord(objectRecord(envelope.payload).item);
    const run = String(row.runId ?? envelope.runId ?? "");
    if (item.type === "tool_use" && item.name === "call_api") {
      const input = objectRecord(item.input);
      if (input.apiPayloadRedacted === true && typeof input.operationId === "string" && digests.has(String(input.apiPayloadSha256))) uses.set(`${run}:${String(item.id)}`, input.operationId);
      continue;
    }
    const tool = item.type === "tool_use" ? taskReadTool(item.name) : undefined;
    if (tool) {
      const request = taskReadInput(tool, objectRecord(item.input));
      if (request && digests.has(callApiInputDigest(request))) uses.set(`${run}:${String(item.id)}`, String(request.operationId));
      continue;
    }
    if (item.type !== "tool_result") continue;
    const operationId = uses.get(`${run}:${String(item.tool_use_id)}`), result = objectRecord(item.result);
    if (!operationId || result.apiOperationId !== operationId || typeof result.status !== "number") continue;
    statuses.push({ operationId, ok: result.ok === true, status: result.status });
  }
  return statuses;
}

/** True when the run successfully completed one of these record-bound reads. */
export function readRecord(events: readonly Record<string, unknown>[], reads: readonly ApiRead[]) {
  return apiReadStatuses(events, apiReadDigests(reads)).some(read => read.ok && read.status >= 200 && read.status < 300);
}
