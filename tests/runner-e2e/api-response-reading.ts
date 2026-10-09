import { createHash } from "node:crypto";
import type { RunnerTaskFixture } from "./types.js";
import type { RunnerApi } from "./api.js";
import type { IssueAttachment } from "../../packages/shared/src/types/issue.js";

/** Verify delivered bytes through the same public download path the user receives. */
export async function readResponseProof(api: RunnerApi, issueId: string, runId: string) {
  const attachments = await api.get<IssueAttachment[]>(`/api/issues/${issueId}/attachments`);
  const proofs = attachments.filter(attachment =>
    attachment.issueId === issueId && attachment.originatingRunId === runId &&
    attachment.originalFilename === "api-response-proof.txt");
  if (proofs.length !== 1) throw new Error(`Expected one proof attachment from the tested run; observed ${proofs.length}`);
  const proof = proofs[0]!;
  const response = await api.request.get(`/api/attachments/${encodeURIComponent(proof.id)}/content?download=1`);
  if (!response.ok()) throw new Error(`Proof download returned ${response.status()}`);
  const bytes = await response.body();
  if (bytes.length !== proof.byteSize || createHash("sha256").update(bytes).digest("hex") !== proof.sha256) {
    throw new Error("Downloaded proof disagrees with stored attachment bytes");
  }
  return { attachmentId: proof.id, content: bytes.toString("utf8"), sha256: proof.sha256 };
}

export function responseEvidenceCode(nonce: string) {
  return createHash("sha256").update(`bounded-response-evidence:${nonce}`).digest("hex");
}
export function responseEvidenceDescription(nonce: string) {
  return `${"Synthetic diagnostic padding.\n".repeat(1400)}\nEvidence code: ${responseEvidenceCode(nonce)}\n`;
}

/** Correlate trusted PRP call inputs, results, and completion receipts. */
export function gradeApiResponsePaging(events: readonly { eventType?: string; payload?: unknown }[], sourceIssueId: string) {
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const inputs = new Map<string, Record<string, unknown>>();
  const results = new Map<string, Record<string, unknown>>();
  const completed = new Set<string>();
  for (const event of events) {
    const payload = object(object(object(event.payload).prpEvent).payload);
    const item = object(payload.item);
    if (event.eventType === "item.started" && item.type === "tool_use" && item.name === "call_api" && typeof item.id === "string") {
      inputs.set(item.id, object(item.input));
    }
    if (event.eventType === "item.completed" && item.type === "tool_result" && typeof item.id === "string" &&
      (item.tool_use_id === undefined || item.tool_use_id === item.id)) results.set(item.id, object(item.result));
    if (event.eventType === "tool.execution.completed" && payload.name === "call_api" && payload.status === "completed" && typeof payload.executionId === "string") {
      completed.add(payload.executionId);
    }
  }
  const calls = [...inputs].flatMap(([id, input]) => {
    const result = results.get(id);
    return completed.has(id) && result?.ok === true && [200, 206].includes(Number(result.status)) ? [{ input, result }] : [];
  });
  const sourceOperation = "GET /api/issues/{id}";
  const assetOperation = "GET /api/assets/{assetId}/content";
  const sources = calls.filter(call => call.input.operationId === sourceOperation && call.result.apiOperationId === sourceOperation &&
    object(call.input.pathParams).id === sourceIssueId);
  let failure = "No successful call_api source read with a saved response artifact";
  for (const source of sources) {
    const artifact = object(source.result.artifact);
    const assetId = artifact.artifactId;
    const total = artifact.byteSize;
    if (typeof assetId !== "string" || typeof total !== "number" || !Number.isSafeInteger(total) || total <= 24 * 1024 || total > 1024 * 1024 ||
      typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256) || artifact.url !== `/api/assets/${assetId}/content`) continue;
    const pages = new Map<number, { bytes: Buffer; next: number | null }>();
    let malformed = false;
    for (const call of calls) {
      if (call.input.operationId !== assetOperation || object(call.input.pathParams).assetId !== assetId) continue;
      const requested = object(call.input.responseText);
      const returned = object(call.result.responseText);
      const offset = requested.offsetBytes;
      const limit = requested.limitBytes;
      const next = returned.nextOffsetBytes;
      const data = call.result.data;
      if (call.result.apiOperationId !== assetOperation || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= total ||
        typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 8192 || returned.offsetBytes !== offset || returned.totalBytes !== total ||
        typeof data !== "string") { malformed = true; break; }
      const bytes = Buffer.from(data, "utf8");
      const end = offset + bytes.length;
      if (bytes.length === 0 || bytes.length > limit || end > total || (end === total ? next !== null : next !== end)) {
        malformed = true; break;
      }
      const prior = pages.get(offset);
      if (prior && (!prior.bytes.equals(bytes) || prior.next !== next)) { malformed = true; break; }
      pages.set(offset, { bytes, next: next as number | null });
    }
    if (malformed) { failure = "Artifact paging request, returned offsets, bytes, or EOF disagree"; continue; }
    const chunks: Buffer[] = [];
    const offsets: number[] = [];
    let offset = 0;
    let eofReached = false;
    while (pages.has(offset)) {
      const page = pages.get(offset)!;
      chunks.push(page.bytes); offsets.push(offset);
      if (page.next === null) { eofReached = true; break; }
      offset = page.next;
    }
    if (!eofReached || offsets.length < 2) { failure = "Saved artifact pages do not cover offset zero through EOF without gaps"; continue; }
    const bytes = Buffer.concat(chunks);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== total || digest !== artifact.sha256) { failure = "Paged bytes disagree with the source response artifact digest"; continue; }
    try {
      if (object(JSON.parse(bytes.toString("utf8"))).id !== sourceIssueId) { failure = "Paged artifact belongs to another source issue"; continue; }
    } catch { failure = "Paged source response is not complete JSON"; continue; }
    return { passed: true, sourceIssueId, artifactId: assetId, totalBytes: total, pageCount: offsets.length, offsets, eofReached, sha256: digest };
  }
  return { passed: false, sourceIssueId, failure };
}

export const apiResponseReadingTask: RunnerTaskFixture = {
  id: "saved-text-pages", label: "Read saved large API evidence", groups: [],
  workMode: "standard", flow: "single_turn", expectedRunCount: 1,
  attemptTimeoutMs: { local: 10 * 60_000, daytona: 10 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Read large API evidence ${nonce}`,
  // Delivered files render as an attachment card, which can replace the finish summary.
  buildVisibleMarker: () => "api-response-proof.txt",
  buildPrompt: nonce => [
    "Inspect diagnostic evidence task {{API_RESPONSE_SOURCE_ID}} using the Paperclip API tools.",
    "Discover GET /api/issues/{id}, call it for that task, and retain the returned response artifact.",
    "Read the saved artifact through GET /api/assets/{assetId}/content with responseText: {offsetBytes:0,limitBytes:8192}.",
    "Continue using responseText.nextOffsetBytes until null. Extract the Evidence code at the end of its description.",
    "The large response must be read with bounded responseText pages. Do not use other tools or API routes to obtain the evidence; if bounded reading fails, report the failure instead of substituting a different reader.",
    "Write only that code followed by a newline to api-response-proof.txt in the current workspace and deliver that file as an attachment. Do not edit the evidence task or create child tasks.",
    `Verify the proof file and finish this task with paperclip_finish, reportedWorkDisposition done, and summary API_RESPONSE_READ_${nonce}.`,
  ].join("\n"),
  buildMatchers: (nonce, execution) => [
    { kind: "file_exact", path: "api-response-proof.txt", expected: `${responseEvidenceCode(nonce)}\n` },
    { kind: "message_contains", expected: "api-response-proof.txt" },
    { kind: "issue_status", expected: "done" },
    { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: execution.profile.expectedRuntimeMode },
    { kind: "environment", expected: execution.environment.id },
  ],
};
