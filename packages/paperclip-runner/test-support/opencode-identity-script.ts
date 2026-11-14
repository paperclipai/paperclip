import { isDeepStrictEqual } from "node:util";

/** Synthetic protocol data only. Never use this fixture to grade a product task. */
export const diagnosticPrompt = "Run the synthetic identity protocol diagnostic.";
export const identityCallIds = Array.from({ length: 5 }, (_, index) => `diagnostic-identity-${index + 1}`);
export const diagnosticIdentity = { ok: true, identity: { agentId: "synthetic-agent", companyId: "synthetic-company" } };
export const failedIdentity = { ok: false, code: "CONTROLLED_IDENTITY_FAILURE" };
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
function identityValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return null;
  if (typeof value === "string") { try { return identityValue(JSON.parse(value), depth + 1); } catch { return null; } }
  const r = row(value);
  if (r.type === "inputText" && typeof r.text === "string") return identityValue(r.text, depth + 1);
  return r;
}
export function acceptedIdentityIds(messages: unknown): string[] {
  if (!Array.isArray(messages)) throw new Error("diagnostic_messages_invalid");
  const found: string[] = [];
  for (const message of messages) {
    const m = row(message);
    if (m.role !== "tool") continue;
    if (!identityCallIds.includes(String(m.tool_call_id))) throw new Error("diagnostic_identity_foreign");
    if (!isDeepStrictEqual(identityValue(m.content), diagnosticIdentity)) throw new Error("diagnostic_identity_rejected");
    if (found.includes(String(m.tool_call_id))) throw new Error("diagnostic_identity_duplicate");
    found.push(String(m.tool_call_id));
  }
  return found;
}
export function identityAcceptanceComplete(messages: unknown): boolean {
  return JSON.stringify(acceptedIdentityIds(messages)) === JSON.stringify(identityCallIds);
}
export function identityResponse(body: unknown, negative = false, expectedPreviousId?: string) {
  const b = row(body);
  if (b.model !== "protocol-diagnostic" || !Array.isArray(b.messages)) throw new Error("diagnostic_request_invalid");
  const tools = Array.isArray(b.tools) ? b.tools.map(value => row(row(value).function)) : [];
  const tool = tools.filter(value => /(?:^|_)get_identity$/.test(String(value.name)));
  const hasMainPrompt = b.messages.some(value => row(value).role === "user" && (JSON.stringify(row(value).content) ?? "").includes(diagnosticPrompt));
  // OpenCode may ask the same small model for a title. Such requests do not
  // consume the pending main-call response or advance the identity script.
  if (tool.length === 0) return { accepted: [], negativeObserved: false, auxiliary: true,
    delta: { role: "assistant", content: "Protocol diagnostic" }, finish: "stop" };
  if (tool.length !== 1 || !hasMainPrompt || b.stream !== true) throw new Error("diagnostic_main_request_invalid");
  if (expectedPreviousId && (!identityCallIds.includes(expectedPreviousId)
    || !b.messages.some(value => row(value).role === "tool" && row(value).tool_call_id === expectedPreviousId)))
    throw new Error("diagnostic_next_result_missing");
  let accepted: string[];
  try { accepted = acceptedIdentityIds(b.messages); }
  catch (error) {
    const first = b.messages.find(value => row(value).role === "tool" && row(value).tool_call_id === identityCallIds[0]);
    if (!negative || !isDeepStrictEqual(identityValue(row(first).content), failedIdentity)) throw error;
    return { accepted: [], negativeObserved: true, auxiliary: false, delta: { role: "assistant", content: "Controlled negative completed." }, finish: "stop" };
  }
  if (accepted.length === identityCallIds.length) return { accepted, negativeObserved: false, auxiliary: false,
    delta: { role: "assistant", content: "Protocol diagnostic completed." }, finish: "stop" };
  return { accepted, negativeObserved: false, auxiliary: false, delta: { role: "assistant", tool_calls: [{ index: 0,
    id: identityCallIds[accepted.length], type: "function", function: { name: tool[0]!.name, arguments: "{}" } }] }, finish: "tool_calls" };
}
export function diagnosticChildEnvironment(path: string): NodeJS.ProcessEnv {
  return { PATH: path, LANG: "C.UTF-8" };
}

const rejectionReasons = new Set(["diagnostic_route", "diagnostic_body_bound", "diagnostic_request_invalid",
  "diagnostic_main_request_invalid", "diagnostic_next_result_missing", "diagnostic_identity_rejected",
  "diagnostic_identity_duplicate", "diagnostic_identity_foreign", "diagnostic_messages_invalid"]);
export function closedRejection(error: unknown, stage: string, ordinal: number, body: unknown, pending?: string) {
  const b = row(body), messages = Array.isArray(b.messages) ? b.messages : [];
  const tools = Array.isArray(b.tools) ? b.tools.map(value => row(row(value).function)) : [];
  const count = tools.filter(value => /(?:^|_)get_identity$/.test(String(value.name))).length;
  const pendingMessage = messages.find(value => row(value).role === "tool" && row(value).tool_call_id === pending);
  const content = row(pendingMessage).content, decoded = identityValue(content), value = row(decoded);
  const shape = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array"
    : typeof value === "string" ? "string" : typeof value === "object" ? "record" : "other";
  return { reason: error instanceof Error && rejectionReasons.has(error.message) ? error.message : "unknown_withheld",
    stage: ["route", "body", "parse", "script", "respond"].includes(stage) ? stage : "unknown",
    ordinal: Number.isInteger(ordinal) ? Math.max(0, Math.min(13, ordinal)) : 0,
    modelExact: b.model === "protocol-diagnostic", messagesArray: Array.isArray(b.messages),
    identityToolCount: count === 0 ? "zero" : count === 1 ? "one" : "many",
    mainPromptPresent: messages.some(value => row(value).role === "user" && (JSON.stringify(row(value).content) ?? "").includes(diagnosticPrompt)),
    stream: b.stream === true ? "true" : b.stream === false ? "false" : "other",
    pendingIndex: pending ? identityCallIds.indexOf(pending) + 1 : 0,
    pendingResultPresent: !!pending && !!pendingMessage,
    pendingContentShape: pendingMessage ? shape(content) : "missing", pendingDecodedShape: pendingMessage ? shape(decoded) : "missing",
    pendingIdentityKeys: pendingMessage && Object.keys(value).sort().join() === "identity,ok"
      && Object.keys(row(value.identity)).sort().join() === "agentId,companyId" ? "exact" : "different",
    pendingIdentityValueMatch: pendingMessage && isDeepStrictEqual(decoded, diagnosticIdentity) ? "exact" : "different",
    pendingControlledErrorMatch: pendingMessage && isDeepStrictEqual(decoded, failedIdentity) ? "exact" : "different" };
}
export function closedTerminalStatus(value: unknown): "completed" | "failed" | "cancelled" | "interrupted" | "unknown" {
  const n = row(value), status = row(row(n.params).turn).status;
  return n.method === "turn/completed" && ["completed", "failed", "cancelled", "interrupted"].includes(String(status))
    ? status as "completed" | "failed" | "cancelled" | "interrupted" : "unknown";
}
