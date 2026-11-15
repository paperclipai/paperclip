import { describe, expect, it, vi } from "vitest";
import type { CodexRpcNotification } from "../drivers/codex/app-server-transport.js";
import type { CapabilityLiveTransportFactory } from "../live/live-session.js";
import { evalFailureDiagnosticFromError, evalProviderFailureDiagnostic, observeEvalProviderFailures } from "./eval-failure-diagnostics.js";

const notification = (providerFailure: unknown): CodexRpcNotification => ({ method: "turn/completed", params: {
  turn: { status: "failed", error: { providerFailure } },
} });
const failure = { schema: "paperclip.provider-failure.v1", provider: "claude", phase: "turn", category: "authentication",
  httpStatus: 401, retryability: "requires_action", message: "Bearer PRIVATE-SECRET", requestId: "private-id", providerCode: "private-code" };

describe("eval-only terminal failure diagnostics", () => {
  it("retains only validated closed failure facts before evidence redaction", () => {
    const projected = evalProviderFailureDiagnostic(notification({ ...failure, headers: { Authorization: "PRIVATE-SECRET" } }));
    expect(projected).toEqual({ phase: "turn", category: "authentication", httpStatus: 401, retryability: "requires_action" });
    expect(JSON.stringify(projected)).not.toMatch(/PRIVATE|private|Bearer|message|requestId|providerCode|headers/);
  });

  it("keeps malformed and unavailable causes explicitly unknown", () => {
    for (const value of [null, [], {}, "PRIVATE-SECRET", { ...failure, category: "PRIVATE-SECRET" },
      { ...failure, phase: "other" }, { ...failure, httpStatus: 999 }, { ...failure, retryability: "always" }]) {
      expect(evalProviderFailureDiagnostic(notification(value))).toEqual({ phase: "turn", category: "unknown", retryability: "unknown" });
    }
  });

  it("retains a startup rejection's existing typed facts without provider text", () => {
    const error = Object.assign(new Error("Startup rejected"), { runnerCommandResult: { result: {
      providerFailure: { ...failure, phase: "startup" }, raw: "PRIVATE-SECRET",
    } } });
    expect(evalFailureDiagnosticFromError(error)).toEqual({ phase: "startup", category: "authentication", httpStatus: 401, retryability: "requires_action" });
    expect(evalFailureDiagnosticFromError(new Error("PRIVATE-SECRET"))).toBeNull();
  });

  it("does not reinterpret completed, canceled or nonterminal events", () => {
    for (const status of ["completed", "cancelled", "interrupted", "running", undefined]) {
      expect(evalProviderFailureDiagnostic({ method: "turn/completed", params: { turn: { status, error: { providerFailure: failure } } } })).toBeNull();
    }
    expect(evalProviderFailureDiagnostic({ method: "provider/notice", params: notification(failure).params })).toBeNull();
  });

  it("forwards the same real transport notifications and leaves requests and cleanup intact", async () => {
    const failed = notification(failure), completed: CodexRpcNotification = { method: "turn/completed", params: { turn: { status: "completed" } } };
    const notices = [failed, completed];
    const transport = { request: vi.fn(async () => ({})), notify: vi.fn(), close: vi.fn(async () => {}), setServerRequestHandler: vi.fn(),
      async *notifications() { yield* notices; } };
    const bundle = { transport, evidence: vi.fn(() => ({})), detachControllerForRestart: vi.fn(async () => {}) };
    const factory = vi.fn(() => bundle) as unknown as CapabilityLiveTransportFactory;
    const recorded = vi.fn(), wrapped = observeEvalProviderFailures(factory, recorded)({});
    const forwarded = [];
    for await (const event of wrapped.transport.notifications()) forwarded.push(event);
    expect(forwarded).toEqual(notices);
    expect(forwarded[0]).toBe(failed);
    expect(recorded).toHaveBeenCalledExactlyOnceWith({ phase: "turn", category: "authentication", httpStatus: 401, retryability: "requires_action" });
    expect(wrapped.transport.request).toBe(transport.request);
    expect(wrapped.transport.close).toBe(transport.close);
  });
});
