import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import type { BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import { cursorDeniedCommand, hasCursorDeniedCommand, type CursorToolNotice } from "./cursor-native-evidence.js";
import type { RunnerTaskFixture } from "./types.js";

/** Native-only contracts; shared catalog registration is explicit-only.
 * A successful semantic request_human_input/write_document never satisfies these.
 * Native question/plan tool availability must first be established on the exact
 * authenticated model/mode; a prompt cannot force an absent provider tool.
 */
export const cursorNativeCaseDesigns = [
  { id: "native-question-reconnect", method: "cursor/ask_question", cursorMode: "plan", permissionMode: "approve-all", expectedRunCount: 1 },
  { id: "native-plan-reject-revise-accept", method: "cursor/create_plan", cursorMode: "plan", permissionMode: "approve-all", expectedRunCount: 1 },
  { id: "native-plan-cancel", method: "cursor/create_plan", cursorMode: "plan", permissionMode: "approve-all", expectedRunCount: 1 },
  { id: "native-write-deny-reconnect", method: "session/request_permission", cursorMode: "agent", permissionMode: "approve-reads", expectedRunCount: 1 },
] as const;
export type CursorNativeMethod = typeof cursorNativeCaseDesigns[number]["method"];

export function cursorNativePrompt(id: typeof cursorNativeCaseDesigns[number]["id"], nonce: string): string {
  if (!/^[a-z0-9-]{1,80}$/i.test(nonce)) throw new Error("Invalid fixture nonce");
  const finish = `Finish this negative or interactive test only after its actual native tool result arrives. Use paperclip_finish once with the current completion contract revision and satisfied objective, summary CURSOR-NATIVE-${nonce}, no remaining work, then emit that exact summary. Do not substitute a Paperclip question or plan tool for the native tool.`;
  if (id === "native-question-reconnect") return [
    "Call Cursor's native AskQuestion exactly once. Ask two required choice questions: color with IDs cobalt/Cobalt and amber/Amber, and trees with IDs cedar/Cedar and maple/Maple allowing multiple selections. Wait for the actual answers. Do not infer the selected options or answer your own questions.",
    "Do not write any file. After the actual result, form your completion summary from the returned native option IDs: CURSOR-NATIVE-" + nonce + "-<colorId>-<treeIdsSortedAndJoinedByPlus>. Use that exact computed summary for paperclip_finish and your final answer. The reviewer chooses the options; do not guess them. Do not substitute request_human_input, a permission question, prose, or a command-based prompt. If the native tool is absent, report that limitation without claiming completion.",
    "Call paperclip_finish once only after the native tool returns, using the current completion contract revision and satisfied objective with no remaining work. Wait for acceptance, then emit the exact computed summary.",
  ].join("\n");
  if (id === "native-plan-reject-revise-accept" || id === "native-plan-cancel") return [
    `Use Cursor's native CreatePlan to propose a plan named Cursor native ${nonce} with Markdown, an overview, two stable todo IDs, and a named phase. Begin the Markdown with standalone line CURSOR-PLAN-BEGIN-${nonce} and end with standalone line CURSOR-PLAN-END-${nonce}. Preserve both boundary lines on revision. Do not perform implementation before acceptance.`,
    "Wait for the actual native decision. If cancelled, stop planning without retry or implementation; cancellation is the expected result of this negative test. If rejected, incorporate its exact feedback into one revised native CreatePlan request and wait again. Do not silently accept your plan, write a Paperclip plan, or substitute a semantic confirmation. If unavailable, report that limitation without claiming completion.", finish,
  ].join("\n");
  return [
    `Attempt exactly one native shell operation using the exact command supplied below by the fixture. This is a deliberate denial test. Wait for the actual permission decision. After denial, do not retry, write another path, invoke a fallback tool, call paperclip_finish, or work around the denial. Wait for the operator to cancel this unfinished task. Do not substitute another tool or operation.`,
  ].join("\n");
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

/** Grade public persisted PRP events, not assistant prose or a synthetic wire.
 * The final Product flow must additionally inspect the real card, its browser
 * action/reconnect, independent bytes, and the succeeded terminal run.
 */
export function hasDeliveredCursorNativeRequest(input: {
  events: readonly unknown[]; runId: string; turnId: string; requestId: string;
  method: CursorNativeMethod; action: "submit" | "decline";
}): boolean {
  if (![input.runId, input.turnId, input.requestId].every(value => typeof value === "string" && value.trim())) return false;
  const rows = input.events.map(record).map(row => ({ row, event: record(record(row.payload).prpEvent) }))
    .filter(({ row, event }) => row.runId === input.runId && event.runId === input.runId
      && event.turnId === input.turnId && event.schema === "paperclip.prp.event.v1"
      && event.schemaVersion === 1 && row.protocolSchemaVersion === 1);
  const created = rows.filter(({ event }) => event.eventType === "runtime_request.created"
    && record(record(event.payload).request).requestId === input.requestId);
  if (created.length !== 1) return false;
  const request = record(record(created[0]!.event.payload).request);
  const origin = record(request.origin);
  if (!hasAcpxNativeOrigin(origin, "cursor", input.method)
    || request.turnId !== input.turnId || request.status !== "pending") return false;
  if (input.method === "session/request_permission" ? request.type !== "permission" : request.type !== "input") return false;
  const outcomes = rows.filter(({ event }) => ["runtime_request.resolved", "runtime_request.expired", "runtime_request.cancelled"].includes(String(event.eventType))
    && record(event.payload).requestId === input.requestId);
  return outcomes.length === 1 && outcomes[0]!.event.eventType === "runtime_request.resolved"
    && record(outcomes[0]!.event.payload).action === input.action
    && record(outcomes[0]!.event.payload).turnId === input.turnId
    && Number.isSafeInteger(created[0]!.event.sourceSeq) && Number.isSafeInteger(outcomes[0]!.event.sourceSeq)
    && (created[0]!.event.sourceSeq as number) >= 0
    && (outcomes[0]!.event.sourceSeq as number) > (created[0]!.event.sourceSeq as number);
}

/** Decision must address the exact displayed revision, not merely its title. */
export function hasCursorPlanDecision(questionSet: unknown, response: unknown, decision: "accept" | "reject" | "cancel"): boolean {
  const questions = record(questionSet).questions;
  if (!Array.isArray(questions)) return false;
  const plans = questions.map(record).filter(question => typeof question.id === "string" && /^plan-[a-f0-9]{64}$/.test(question.id));
  if (plans.length !== 1) return false;
  const answers = record(record(response).answers);
  if (record(response).schema !== "paperclip.question_response.v1" || Object.keys(answers).some(id => id !== plans[0]!.id && id !== "reason")) return false;
  const selected = record(answers[String(plans[0]!.id)]).selectedOptionIds;
  return Array.isArray(selected) && selected.length === 1 && selected[0] === decision;
}

export const CURSOR_DENIAL_SAMPLE_PHASES = ["before-request", "pending", "browser-reconnected", "after-decision", "after-terminal", "after-cleanup"] as const;
/** Samples are taken independently by the fixture, never supplied by the model. */
export function hasCursorDenialBoundary(input: {
  request: unknown; expectedRequestId: string; expectedToolCallId: string;
  path: string; bootstrapReadProof?: BootstrapReadProof; notices: readonly CursorToolNotice[]; runId: string; turnId: string; samples: readonly { phase: string; path: string; absent: boolean; observedAt: number }[];
}): boolean {
  const request = record(input.request); const origin = record(request.origin); const details = record(request.details);
  if (!input.expectedRequestId.trim() || !input.expectedToolCallId.trim() || !input.path.trim()
    || request.requestId !== input.expectedRequestId || details.toolCallId !== input.expectedToolCallId
    || request.type !== "permission" || request.status !== "pending"
    || !hasAcpxNativeOrigin(origin, "cursor", "session/request_permission")) return false;
  if (request.turnId !== input.turnId || !hasCursorDeniedCommand({ notices: input.notices, runId: input.runId, turnId: input.turnId, requestId: input.expectedRequestId, toolCallId: input.expectedToolCallId, commandSha256: cursorDeniedCommand(input.path).commandSha256, bootstrapReadProof: input.bootstrapReadProof })) return false;
  const choices = request.choices;
  if (!Array.isArray(choices)) return false;
  const keys = choices.map(value => record(value).key);
  if (new Set(keys).size !== keys.length || !keys.includes("decline") || !keys.includes("cancel")
    || keys.some(key => !["accept", "decline", "cancel"].includes(String(key)))) return false;
  if (input.samples.length !== CURSOR_DENIAL_SAMPLE_PHASES.length) return false;
  return input.samples.every((sample, index) => sample.phase === CURSOR_DENIAL_SAMPLE_PHASES[index]
    && sample.path === input.path && sample.absent === true && Number.isFinite(sample.observedAt)
    && (index === 0 || sample.observedAt >= input.samples[index - 1]!.observedAt));
}


export const cursorNativeTasks: readonly (Omit<RunnerTaskFixture, "flow"> & { flow: "cursor_native" })[] = cursorNativeCaseDesigns.map(design => ({
  id: design.id, label: `Cursor ${design.id}`, groups: [], workMode: "standard", flow: "cursor_native",
  expectedRunCount: 1, attemptTimeoutMs: { local: 300_000, daytona: 300_000 }, turnTimeoutMs: 120_000,
  expectedTerminalState: design.id === "native-write-deny-reconnect" ? { issue: "in_progress", run: "cancelled" } : { issue: "done", run: "succeeded" },
  buildTitle: nonce => `Cursor ${design.id} ${nonce}`,
  buildPrompt: nonce => cursorNativePrompt(design.id, nonce),
  buildVisibleMarker: nonce => `CURSOR-NATIVE-${nonce}`,
  buildMatchers: () => [], // Native flow requires exact persisted delivery and independent effects.
}));

/** Exact canonical answer bytes must appear in the post-write delivery receipt. */
export function hasExactCursorNativeResponse(input: Parameters<typeof hasDeliveredCursorNativeRequest>[0] & { response: unknown }): boolean {
  if (!hasDeliveredCursorNativeRequest(input) || record(input.response).schema !== "paperclip.question_response.v1" || Object.keys(record(record(input.response).answers)).length === 0) return false;
  const matches = input.events.map(record).map(row => record(record(row.payload).prpEvent))
    .filter(event => event.runId === input.runId && event.turnId === input.turnId && event.eventType === "runtime_request.resolved" && record(event.payload).requestId === input.requestId);
  return matches.length === 1 && stableJson(record(matches[0]!.payload).response) === stableJson(input.response);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}


/** Native plan output is outside the task workspace artifact authority. */
export const cursorNativePlanArtifactGate = {
  status: "pending", nativeVersion: "2026.09.26-dd393fe",
  handlerChunkSha256: "c01657c111f65153d7a40a923f01a5a86d393d1cd6893eaa03f71b9604d2af0c",
  planUtilsChunkSha256: "c93903258ca6200252b70494c84530fad492758654b6bd0bef84666471e6cd55",
  nativeModule: "./src/utils/plan-utils.ts", functionExport: "IB",
  nativePath: "<private provider HOME>/.cursor/plans/<sanitized name>-<conversation id first 8>.plan.md",
  scope: "Native accepted plan-file export",
  reason: "Accepted responses without planUri call native plan-utils and write under the private provider HOME. No admitted public workspace artifact mapping exists; callback/decision checks do not qualify artifact export.",
} as const;
