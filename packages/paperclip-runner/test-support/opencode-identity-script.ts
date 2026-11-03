/** Synthetic protocol data only. Never use this fixture to grade a product task. */
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
    if (JSON.stringify(identityValue(m.content)) !== JSON.stringify(diagnosticIdentity)) throw new Error("diagnostic_identity_rejected");
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
  if (b.model !== "protocol-diagnostic" || b.stream !== true || !Array.isArray(b.messages)) throw new Error("diagnostic_request_invalid");
  if (expectedPreviousId && (!identityCallIds.includes(expectedPreviousId)
    || !b.messages.some(value => row(value).role === "tool" && row(value).tool_call_id === expectedPreviousId)))
    throw new Error("diagnostic_next_result_missing");
  const tools = Array.isArray(b.tools) ? b.tools.map(value => row(row(value).function)) : [];
  const tool = tools.filter(value => /(?:^|_)get_identity$/.test(String(value.name)));
  if (tool.length !== 1) throw new Error("diagnostic_tool_missing");
  let accepted: string[];
  try { accepted = acceptedIdentityIds(b.messages); }
  catch (error) {
    const first = b.messages.find(value => row(value).role === "tool" && row(value).tool_call_id === identityCallIds[0]);
    if (!negative || JSON.stringify(identityValue(row(first).content)) !== JSON.stringify(failedIdentity)) throw error;
    return { accepted: [], negativeObserved: true, delta: { role: "assistant", content: "Controlled negative completed." }, finish: "stop" };
  }
  if (accepted.length === identityCallIds.length) return { accepted, negativeObserved: false,
    delta: { role: "assistant", content: "Protocol diagnostic completed." }, finish: "stop" };
  return { accepted, negativeObserved: false, delta: { role: "assistant", tool_calls: [{ index: 0,
    id: identityCallIds[accepted.length], type: "function", function: { name: tool[0]!.name, arguments: "{}" } }] }, finish: "tool_calls" };
}
export function diagnosticChildEnvironment(path: string): NodeJS.ProcessEnv {
  return { PATH: path, LANG: "C.UTF-8" };
}
