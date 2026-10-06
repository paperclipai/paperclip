import { describe, expect, it } from "vitest";
import type { PrpEvent, PrpTerminalState } from "../../vendor/paperclip-runner/index.js";
import { createNativeProviderFailureObservation, NATIVE_MODEL_REJECTION_DIAGNOSTIC, NATIVE_MODEL_REJECTION_MESSAGE } from "./native-provider-failure.js";

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

  it.each([{ kind: "claude", model }, { kind: "codex" }, { kind: "codex", model: "other" }])(
    "does not apply a rejection to another selected provider/model (%j)", (provider) => {
      const observed = createNativeProviderFailureObservation(provider);
      observed.observe(event);
      expect(observed.forTerminal("turn", terminal)).toBeNull();
    },
  );
});
