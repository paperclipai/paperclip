import { createHash } from "node:crypto";
import type { RunnerTaskFixture } from "./types.js";

export function responseEvidenceCode(nonce: string) {
  return createHash("sha256").update(`bounded-response-evidence:${nonce}`).digest("hex");
}
export function responseEvidenceDescription(nonce: string) {
  return `${"Synthetic diagnostic padding.\n".repeat(1400)}\nEvidence code: ${responseEvidenceCode(nonce)}\n`;
}

export function successfulApiReadCount(events: readonly { eventType?: string; payload?: unknown }[]) {
  return events.filter(event => {
    const outer = event.payload as { prpEvent?: { payload?: { name?: string; status?: string } } } | null;
    const payload = outer?.prpEvent?.payload;
    return event.eventType === "tool.execution.completed" && payload?.name === "call_api" && payload.status === "completed";
  }).length;
}

export const apiResponseReadingTask: RunnerTaskFixture = {
  id: "saved-text-pages", label: "Read saved large API evidence", groups: [],
  workMode: "standard", flow: "single_turn", expectedRunCount: 1,
  attemptTimeoutMs: { local: 10 * 60_000, daytona: 10 * 60_000 },
  expectedTerminalState: { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Read large API evidence ${nonce}`,
  buildVisibleMarker: nonce => `API_RESPONSE_READ_${nonce}`,
  buildPrompt: nonce => [
    "Inspect diagnostic evidence task {{API_RESPONSE_SOURCE_ID}} using the Paperclip API tools.",
    "Discover GET /api/issues/{id}, call it for that task, and retain the returned response artifact.",
    "Read the saved artifact through GET /api/assets/{assetId}/content with responseText: {offsetBytes:0,limitBytes:8192}.",
    "Continue using responseText.nextOffsetBytes until null. Extract the Evidence code at the end of its description.",
    "The large response must be read with bounded responseText pages. Do not use other tools or API routes to obtain the evidence; if bounded reading fails, report the failure instead of substituting a different reader.",
    "Write only that code followed by a newline to api-response-proof.txt in the current workspace. Do not edit the evidence task or create child tasks.",
    `Verify the proof file and finish this task with paperclip_finish, reportedWorkDisposition done, and summary API_RESPONSE_READ_${nonce}.`,
  ].join("\n"),
  buildMatchers: (nonce, execution) => [
    { kind: "file_exact", path: "api-response-proof.txt", expected: `${responseEvidenceCode(nonce)}\n` },
    { kind: "message_contains", expected: `API_RESPONSE_READ_${nonce}` },
    { kind: "issue_status", expected: "done" },
    { kind: "run_status", expected: "succeeded" },
    { kind: "runtime_mode", expected: execution.profile.expectedRuntimeMode },
    { kind: "environment", expected: execution.environment.id },
  ],
};
