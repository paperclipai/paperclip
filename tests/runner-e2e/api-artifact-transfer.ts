import { createHash } from "node:crypto";
import type { RunnerTaskFixture } from "./types.js";
import { responseEvidenceCode } from "./api-response-reading.js";

export function usesApiResponseProof(suiteId: string) {
  return suiteId === "api-response-reading" || suiteId === "api-artifact-transfer";
}

export function artifactTransferDescription(nonce: string) {
  const size = 388131;
  const line = 'Synthetic diagnostic data: snowman ☃, quote ", backslash \\, newline\n';
  const suffix = `\nEvidence code: ${responseEvidenceCode(nonce)}\n`;
  const count = Math.floor((size - Buffer.byteLength(suffix)) / Buffer.byteLength(line));
  const body = line.repeat(count);
  return body + ".".repeat(size - Buffer.byteLength(body + suffix)) + suffix;
}

export function gradeApiArtifactTransfer(
  events: readonly { eventType?: string; payload?: unknown }[],
  sourceIssueId: string,
  proof: { content: string; sha256: string },
  expectedDescription: string,
) {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results = new Map<string, Record<string, unknown>>();
  const completed = new Map<string, string>();
  const reject = (failure: string) => ({ passed: false as const, failure });
  for (const event of events) {
    const payload = record(record(record(event.payload).prpEvent).payload);
    const item = record(payload.item);
    if (event.eventType === "item.started" && item.type === "tool_use" &&
        ["call_api", "download_artifact"].includes(String(item.name)) && typeof item.id === "string") {
      calls.set(item.id, { name: String(item.name), input: record(item.input) });
    }
    if (event.eventType === "item.completed" && item.type === "tool_result" && typeof item.id === "string" &&
        (item.tool_use_id === undefined || item.tool_use_id === item.id)) results.set(item.id, record(item.result));
    if (event.eventType === "tool.execution.completed" && payload.status === "completed" && typeof payload.executionId === "string") {
      completed.set(payload.executionId, String(payload.name));
    }
  }
  const successful = [...calls].flatMap(([id, call]) => {
    const result = results.get(id);
    return result && completed.get(id) === call.name ? [{ ...call, result }] : [];
  });
  let source: Record<string, unknown>;
  try { source = record(JSON.parse(proof.content)); }
  catch { return reject("Delivered artifact is not complete JSON"); }
  if (source.id !== sourceIssueId || source.description !== expectedDescription) {
    return reject("Delivered bytes do not contain the complete seeded source");
  }
  const bytes = Buffer.from(proof.content);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== proof.sha256) return reject("Delivered attachment digest disagrees with downloaded bytes");
  for (const call of successful) {
    if (call.name !== "call_api" || call.input.operationId !== "GET /api/issues/{id}" ||
        record(call.input.pathParams).id !== sourceIssueId || call.result.ok !== true || call.result.status !== 200 ||
        call.result.apiOperationId !== "GET /api/issues/{id}") continue;
    const artifact = record(call.result.artifact);
    if (typeof artifact.artifactId !== "string" || artifact.byteSize !== bytes.length || artifact.sha256 !== digest ||
        artifact.url !== `/api/assets/${artifact.artifactId}/content`) continue;
    const install = successful.find(candidate => candidate.name === "download_artifact" &&
      candidate.input.artifactId === artifact.artifactId && candidate.input.destination === "api-response-proof.txt" &&
      candidate.input.byteSize === bytes.length && candidate.input.sha256 === digest &&
      candidate.result.outcome === "completed" && candidate.result.artifactId === artifact.artifactId &&
      candidate.result.destination === "api-response-proof.txt" && candidate.result.byteSize === bytes.length &&
      candidate.result.sha256 === digest);
    if (install) return { passed: true as const, sourceIssueId, artifactId: artifact.artifactId,
      byteSize: bytes.length, sha256: digest, installedDestination: "api-response-proof.txt" };
  }
  return reject("No completed artifact installation matches the source capture and delivered bytes");
}

export const apiArtifactTransferTask: RunnerTaskFixture = {
  id: "verified-artifact-copy", label: "Deliver a verified complete API artifact", groups: [],
  workMode: "standard", flow: "single_turn", expectedRunCount: 1,
  automaticRetryPolicy: "single_attempt",
  attemptTimeoutMs: { local: 10 * 60_000, daytona: 10 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Copy complete API evidence ${nonce}`,
  buildVisibleMarker: () => "api-response-proof.txt",
  buildPrompt: nonce => [
    "Inspect diagnostic evidence task {{API_RESPONSE_SOURCE_ID}} using Paperclip API tools.",
    "Discover GET /api/issues/{id}, call it for that task, and retain its returned response artifact identity.",
    "Use download_artifact to copy that exact artifact into api-response-proof.txt in the execution workspace, passing its returned artifactId, byteSize and sha256.",
    "Do not reconstruct, retype, rewrite, or execute the artifact contents. Do not fetch the response through shell credentials or substitute another reader. Report a missing download capability as a failure.",
    "Verify the installed file as JSON, including its source issue ID, complete description and Evidence code. Deliver the unchanged full JSON file as an attachment named api-response-proof.txt. Do not edit the evidence task or create children.",
    `Finish this task with paperclip_finish, reportedWorkDisposition done, and summary API_ARTIFACT_TRANSFER_${nonce}.`,
  ].join("\n"),
  buildMatchers: (_nonce, execution) => [
    { kind: "message_contains", expected: "api-response-proof.txt" },
    { kind: "issue_status", expected: "done" },
    { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: execution.profile.expectedRuntimeMode },
    { kind: "environment", expected: execution.environment.id },
  ],
};
