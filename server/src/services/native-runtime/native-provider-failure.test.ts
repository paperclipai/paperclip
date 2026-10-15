import { describe, expect, it } from "vitest";
import type { PrpEvent, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { createNativeProviderFailureObservation, NATIVE_MODEL_REJECTION_DIAGNOSTIC, NATIVE_MODEL_REJECTION_MESSAGE, NATIVE_PROVIDER_OVERLOADED_MESSAGE, readNativeTurnFailureDiagnostic } from "./native-provider-failure.js";

const model = "test-model";
const response = {
  type: "error", status: 400,
  error: { type: "invalid_request_error", message: `The '${model}' model is not supported when using Codex with a ChatGPT account.` },
};
const event: PrpEvent = {
  schema: "paperclip.prp.event.v1", runId: "run", normalizedSessionId: "session", turnId: "turn",
  sourceInstanceId: "runner", sourceEventId: "failure", sourceSeq: 1, sourceKind: "runner",
  eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: "2026-01-01T00:00:00.000Z",
  payload: { status: "failed", error: { message: JSON.stringify(response), codexErrorInfo: "other" } },
};
const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "blocked",
};
const observation = () => createNativeProviderFailureObservation({ kind: "codex", model });

describe("native provider failure observation", () => {
  it("surfaces a structured capacity failure without copying arbitrary provider text", () => {
    const observed = createNativeProviderFailureObservation({ kind: "codex" });
    observed.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded", message: "Private arbitrary response" } } });
    expect(observed.forTerminal("turn", terminal)).toEqual({ errorCode: "native_provider_overloaded", errorMessage: NATIVE_PROVIDER_OVERLOADED_MESSAGE, diagnostic: { provider: "codex", category: "server_overloaded" } });
    expect(observed.forTerminal("different-turn", terminal)).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
  });

  it.each(["usageLimitExceeded", "other", "unauthorized", undefined])("does not retry unrelated provider errors (%s)", (codexErrorInfo) => {
    const observed = observation();
    observed.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo, message: NATIVE_PROVIDER_OVERLOADED_MESSAGE } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });
  it("binds the structured rejection to the failed turn and emits no response or model text", () => {
    const observed = observation();
    observed.observe(event);
    observed.observe(event); // A byte-identical committed replay remains idempotent.
    const result = observed.forTerminal("turn", terminal);
    expect(result).toEqual({ errorCode: "native_provider_model_rejected", errorMessage: NATIVE_MODEL_REJECTION_MESSAGE, diagnostic: NATIVE_MODEL_REJECTION_DIAGNOSTIC });
    expect(JSON.stringify(result)).not.toContain(model);
    expect(JSON.stringify(result)).not.toContain("invalid_request_error");
    expect(observed.forTerminal("later-turn", terminal)).toBeNull();
    expect(observed.forTerminal(null, terminal)).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
    expect(observed.forTerminal("turn", { ...terminal, turnTerminalState: "cancelled" })).toBeNull();
  });

  it.each([
    { ...event, sourceKind: "control_plane" as const },
    { ...event, eventType: "item.completed" as const },
    { ...event, eventType: "harness.diagnostic" as const },
    { ...event, turnId: undefined },
    { ...event, payload: { ...event.payload, status: "completed" } },
    { ...event, payload: { ...event.payload, recoverable: true } },
    { ...event, payload: { status: "failed", error: { message: JSON.stringify(response), recoverable: true } } },
  ])("ignores non-authoritative or retryable evidence %#", (unrelated) => {
    const observed = observation();
    observed.observe(unrelated);
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });

  it.each([
    response.error.message, "malformed JSON", " ".repeat(4_097),
    JSON.stringify({ ...response, status: 401 }),
    JSON.stringify({ ...response, status: "400" }),
    JSON.stringify({ ...response, type: "notice" }),
    JSON.stringify({ ...response, error: { ...response.error, type: "server_error" } }),
    JSON.stringify({ ...response, error: { ...response.error, message: "Private arbitrary provider text" } }),
    JSON.stringify({ ...response, error: { ...response.error, message: response.error.message + " Private suffix" } }),
    JSON.stringify({ ...response, error: { ...response.error, message: response.error.message.replace(model, "another-model") } }),
    JSON.stringify([response]), "null",
  ])("leaves unknown failures unchanged %#", (message) => {
    const observed = observation();
    observed.observe({ ...event, payload: { status: "failed", error: { message } } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
  });

  it.each([
    [{ codexErrorInfo: "contextWindowExceeded", message: "Private provider text" }, { codexErrorInfo: "contextWindowExceeded" }],
    [{ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, message: "Private" }, { codexErrorInfo: "responseStreamDisconnected", httpStatus: 502 }],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: "502" } } }, { codexErrorInfo: "httpConnectionFailed" }],
    [{ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 9_999 } } }, { codexErrorInfo: "httpConnectionFailed" }],
    [{ codexErrorInfo: "privateUnknownKind" }, { codexErrorInfo: "unrecognized" }],
    [{ codexErrorInfo: { privateUnknownKind: {} } }, { codexErrorInfo: "unrecognized" }],
    [{ codexErrorInfo: { other: {}, badRequest: {} } }, { codexErrorInfo: "unrecognized" }],
    [{ code: "provider_event_type_invalid", message: "Unknown canonical provider event type.", recoverable: false }, { codexErrorInfo: "absent", runnerFailureCode: "provider_event_type_invalid" }],
    [{ code: "Private Code With Spaces", message: "Private" }, { codexErrorInfo: "absent", runnerFailureCode: "unrecognized" }],
    [{ code: "private_prompt_slug", message: "Private" }, { codexErrorInfo: "absent", runnerFailureCode: "unrecognized" }],
    [{ code: 42, message: "Private" }, { codexErrorInfo: "absent" }],
    [{ message: NATIVE_PROVIDER_OVERLOADED_MESSAGE }, { codexErrorInfo: "absent" }],
  ])("describes an unclassified failed turn with closed vocabulary only %#", (error, expected) => {
    const observed = observation();
    observed.observe({ ...event, payload: { status: "failed", error } });
    expect(observed.forTerminal("turn", terminal)).toBeNull();
    const diagnostic = observed.unclassifiedTurnFailure("turn", terminal);
    expect(diagnostic).toEqual({ provider: "codex", category: "turn_failed", ...expected });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private/i);
    expect(readNativeTurnFailureDiagnostic(diagnostic)).toEqual(diagnostic);
  });

  it("does not describe a classified, unfailed, or unrelated turn as unclassified", () => {
    const rejected = observation();
    rejected.observe(event);
    expect(rejected.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    const overloaded = observation();
    overloaded.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded" } } });
    expect(overloaded.unclassifiedTurnFailure("turn", terminal)).toBeNull();
    const other = observation();
    other.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "sandboxError" } } });
    expect(other.unclassifiedTurnFailure("later-turn", terminal)).toBeNull();
    expect(other.unclassifiedTurnFailure(null, terminal)).toBeNull();
    expect(other.unclassifiedTurnFailure("turn", { ...terminal, runTerminalState: "succeeded" })).toBeNull();
    expect(other.unclassifiedTurnFailure("turn", { ...terminal, turnTerminalState: "cancelled" })).toBeNull();
    const claude = createNativeProviderFailureObservation({ kind: "claude", model });
    claude.observe({ ...event, payload: { status: "failed", error: { codexErrorInfo: "sandboxError" } } });
    expect(claude.unclassifiedTurnFailure("turn", terminal)).toBeNull();
  });

  it.each([
    null, [], "turn_failed",
    { provider: "codex", category: "turn_failed", codexErrorInfo: "private-kind" },
    { provider: "claude", category: "turn_failed", codexErrorInfo: "other" },
    { provider: "codex", category: "server_overloaded", codexErrorInfo: "other" },
  ])("rejects a persisted turn-failure diagnostic outside the vocabulary %#", (value) => {
    expect(readNativeTurnFailureDiagnostic(value)).toBeNull();
  });

  it("drops unbounded fields from a persisted turn-failure diagnostic", () => {
    expect(readNativeTurnFailureDiagnostic({
      provider: "codex", category: "turn_failed", codexErrorInfo: "badRequest", httpStatus: 1.5,
      runnerFailureCode: "private_prompt_slug", message: "private provider response",
    })).toEqual({ provider: "codex", category: "turn_failed", codexErrorInfo: "badRequest", runnerFailureCode: "unrecognized" });
  });

  it.each([{ kind: "claude", model }, { kind: "codex" }, { kind: "codex", model: "other" }])(
    "does not apply a rejection to another selected provider/model (%j)", (provider) => {
      const observed = createNativeProviderFailureObservation(provider);
      observed.observe(event);
      expect(observed.forTerminal("turn", terminal)).toBeNull();
    },
  );
});
