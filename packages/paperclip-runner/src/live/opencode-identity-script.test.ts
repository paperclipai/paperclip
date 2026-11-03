import { expect, it } from "vitest";
import { acceptedIdentityIds, diagnosticChildEnvironment, diagnosticIdentity, failedIdentity, identityAcceptanceComplete, identityCallIds, identityResponse } from "../../test-support/opencode-identity-script.js";
const message = (id: string, value: unknown = diagnosticIdentity) => ({ role: "tool", tool_call_id: id,
  content: JSON.stringify({ type: "inputText", text: JSON.stringify(value) }) });
const body = (messages: unknown[]) => ({ model: "protocol-diagnostic", stream: true, messages,
  tools: [{ type: "function", function: { name: "paperclip_get_identity" } }] });
it("requires all five distinct client-forwarded IDs and valid identity results in subsequent provider requests", () => {
  const messages: unknown[] = [];
  for (const id of identityCallIds) {
    const response = identityResponse(body(messages));
    expect(response.delta.tool_calls?.[0]?.id).toBe(id);
    messages.push(message(id));
  }
  expect(identityAcceptanceComplete(messages)).toBe(true);
  expect(identityResponse(body(messages)).finish).toBe("stop");
});
it("a failed controlled response cannot satisfy the same acceptance criterion", () => {
  const messages = [message(identityCallIds[0]!, failedIdentity)];
  expect(() => identityAcceptanceComplete(messages)).toThrow("diagnostic_identity_rejected");
  expect(identityResponse(body(messages), true).negativeObserved).toBe(true);
  expect(() => identityResponse(body(messages))).toThrow("diagnostic_identity_rejected");
});
it("missing, duplicate, mismatched and malformed results fail instead of accepting handler completion", () => {
  expect(identityAcceptanceComplete(identityCallIds.slice(0, 4).map(id => message(id)))).toBe(false);
  expect(() => acceptedIdentityIds([message("foreign-call")])).toThrow("diagnostic_identity_foreign");
  expect(() => acceptedIdentityIds([message(identityCallIds[0]!), message(identityCallIds[0]!)])).toThrow("diagnostic_identity_duplicate");
  expect(() => acceptedIdentityIds([message(identityCallIds[0]!, { ok: true, identity: { agentId: "wrong" } })])).toThrow();
  expect(() => identityResponse(body([{ role: "tool", tool_call_id: identityCallIds[0], content: "truncated" }]))).toThrow();
});
it("does not inherit credentials or change HOME for a child", () => {
  expect(diagnosticChildEnvironment("/usr/bin:/bin")).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
});
