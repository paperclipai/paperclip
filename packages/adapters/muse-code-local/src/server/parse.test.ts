import { describe, expect, it } from "vitest";
import { isMuseCodeUnknownSessionError, parseMuseCodeJsonl } from "./parse.js";

function line(payloadType: string, payload: Record<string, unknown>, sessionId = "session-1"): string {
  return JSON.stringify({
    schema_version: 1,
    stream: { kind: "session", id: sessionId },
    payload_type: payloadType,
    payload,
  });
}

describe("parseMuseCodeJsonl", () => {
  it("extracts session, model, provider, usage, and final text", () => {
    const stdout = [
      line("run.model.configured", { kind: "run_model_configured", provider_id: "meta", model_id: "muse-wonder-full-1.0" }),
      line("run.output.delta", { kind: "run_output_delta", text: "do" }),
      line("run.output.delta", { kind: "run_output_delta", text: "ne" }),
      line("run.usage", {
        kind: "run_usage",
        models: [{ model: "muse-wonder-full-1.0", input_tokens: 1000, cached_tokens: 400, output_tokens: 50, reasoning_tokens: 10, calls: 2 }],
      }),
      line("run.terminal.completed", { kind: "run_terminal", terminal: "completed", text: "done", reason: null }),
    ].join("\n");

    const parsed = parseMuseCodeJsonl(stdout);
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.model).toBe("muse-wonder-full-1.0");
    expect(parsed.provider).toBe("meta");
    expect(parsed.usage).toEqual({ inputTokens: 600, outputTokens: 60, cachedInputTokens: 400 });
    expect(parsed.usageReported).toBe(true);
    expect(parsed.summary).toBe("done");
    expect(parsed.terminalKind).toBe("completed");
    expect(parsed.errorMessage).toBeNull();
  });

  it("surfaces failed terminals and ignores lifecycle noise", () => {
    const stdout = [
      line("task.lifecycle.failed", { kind: "task_lifecycle", event: { kind: "failed", reason: "reminder sub-task failed" } }),
      line("run.terminal.failed", { kind: "run_terminal", terminal: "failed", text: "", reason: "provider unavailable" }),
    ].join("\n");

    const parsed = parseMuseCodeJsonl(stdout);
    expect(parsed.terminalKind).toBe("failed");
    expect(parsed.errorMessage).toBe("provider unavailable");
    expect(parsed.usageReported).toBe(false);
  });

  it("falls back to accumulated deltas when no terminal text is present", () => {
    const parsed = parseMuseCodeJsonl(line("run.output.delta", { kind: "run_output_delta", text: "hello" }));
    expect(parsed.summary).toBe("hello");
    expect(parsed.errorMessage).toBeNull();
  });

  it("tolerates non-JSON lines mixed into stdout", () => {
    const parsed = parseMuseCodeJsonl(`plain log line\n${line("run.terminal.completed", { kind: "run_terminal", terminal: "completed", text: "ok" })}`);
    expect(parsed.summary).toBe("ok");
  });
});

describe("isMuseCodeUnknownSessionError", () => {
  it("detects missing-session failures", () => {
    expect(isMuseCodeUnknownSessionError("", 'muse: session "abc" not found')).toBe(true);
    expect(isMuseCodeUnknownSessionError("", "error: unknown session id")).toBe(true);
  });

  it("does not flag unrelated failures or model warnings", () => {
    expect(isMuseCodeUnknownSessionError("", "muse: provider unavailable")).toBe(false);
    expect(isMuseCodeUnknownSessionError("", "muse: warning: session abc does not record a usable model")).toBe(false);
  });
});
