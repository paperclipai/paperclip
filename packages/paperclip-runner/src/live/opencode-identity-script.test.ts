import { expect, it } from "vitest";
import { acceptedIdentityIds, closedRejection, closedTerminalStatus, diagnosticChildEnvironment, diagnosticIdentity, diagnosticPrompt, failedIdentity, identityAcceptanceComplete, identityCallIds, identityResponse } from "../../test-support/opencode-identity-script.js";
const message = (id: string, value: unknown = diagnosticIdentity) => ({ role: "tool", tool_call_id: id,
  content: JSON.stringify({ type: "inputText", text: JSON.stringify(value) }) });
const body = (messages: unknown[]) => ({ model: "protocol-diagnostic", stream: true, messages: [{ role: "user", content: diagnosticPrompt }, ...messages],
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

it("rejects a dropped immediate result rather than retrying the same logical call until it appears", () => {
  const issued = identityResponse(body([])).delta.tool_calls![0]!.id;
  expect(() => identityResponse(body([]), false, issued)).toThrow("diagnostic_next_result_missing");
  expect(identityResponse(body([message(issued)]), false, issued).accepted).toEqual([issued]);
  expect(identityResponse(body([message(issued, failedIdentity)]), true, issued).negativeObserved).toBe(true);
});

it("does not mistake auxiliary title requests for the next relevant main-provider request", () => {
  const issued = identityResponse(body([])).delta.tool_calls![0]!.id;
  const title = identityResponse({ model: "protocol-diagnostic", stream: true, messages: [{ role: "user", content: "Create a title" }] }, false, issued);
  expect(title.auxiliary).toBe(true);
  expect(identityResponse({ model: "protocol-diagnostic", stream: false, messages: [] }, false, issued).auxiliary).toBe(true);
  expect(() => identityResponse({ ...body([]), stream: false })).toThrow("diagnostic_main_request_invalid");
  expect(title.accepted).toEqual([]);
  expect(() => identityResponse(body([]), false, issued)).toThrow("diagnostic_next_result_missing");
  expect(identityResponse(body([message(issued)]), false, issued).accepted).toEqual([issued]);
});

it("projects only closed rejection fields and withholds secret-bearing unknown errors and request content", () => {
  const secret = "synthetic-private-secret-that-must-not-print";
  const result = closedRejection(new Error(secret), secret, 999, { model: secret, messages: [{ role: "user", content: secret }], authorization: secret }, secret);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(result.reason).toBe("unknown_withheld"); expect(result.stage).toBe("unknown"); expect(result.ordinal).toBe(13);
  expect(closedRejection(new Error("diagnostic_next_result_missing"), "script", 2, body([]), identityCallIds[0]).reason).toBe("diagnostic_next_result_missing");
});
it("requires the actual completed terminal payload, never merely the shared terminal method", () => {
  for (const status of ["failed", "cancelled", "interrupted", "unknown"]) expect(closedTerminalStatus({ method: "turn/completed", params: { turn: { status } } })).not.toBe("completed");
  expect(closedTerminalStatus({ method: "turn/completed", params: { turn: { status: "completed" } } })).toBe("completed");
  expect(closedTerminalStatus({ method: "turn/completed", params: {} })).toBe("unknown");
});
