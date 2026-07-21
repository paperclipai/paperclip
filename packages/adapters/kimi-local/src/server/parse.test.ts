import { describe, expect, it } from "vitest";
import {
  detectKimiAuthRequired,
  extractKimiRuntimeEvents,
  isKimiSessionUnrecoverableError,
  isKimiTransientNetworkError,
  parseKimiJsonl,
} from "./parse.js";

describe("extractKimiRuntimeEvents", () => {
  it("maps assistant content to an assistant snippet event", () => {
    const events = extractKimiRuntimeEvents('{"role":"assistant","content":"Here is my plan"}');
    expect(events).toEqual([
      { eventType: "assistant", message: "Here is my plan", payload: { content: "Here is my plan" } },
    ]);
  });

  it("maps tool_calls to tool_call events carrying the tool name", () => {
    const line =
      '{"role":"assistant","content":"running","tool_calls":[{"type":"function","id":"t1","function":{"name":"Bash","arguments":"{}"}}]}';
    const events = extractKimiRuntimeEvents(line);
    expect(events).toEqual([
      { eventType: "assistant", message: "running", payload: { content: "running" } },
      { eventType: "tool_call", payload: { toolName: "Bash" } },
    ]);
  });

  it("emits nothing for tool results, meta, and malformed lines", () => {
    expect(extractKimiRuntimeEvents('{"role":"tool","tool_call_id":"t1","content":"done"}')).toEqual([]);
    expect(extractKimiRuntimeEvents('{"role":"meta","type":"session.resume_hint","session_id":"s"}')).toEqual([]);
    expect(extractKimiRuntimeEvents("not json")).toEqual([]);
  });
});

describe("parseKimiJsonl", () => {
  it("collects assistant text from content events", () => {
    const stdout = [
      '{"role":"assistant","content":"PAPERCLIP_ADAPTER_TEST_OK"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session_769ddab9-0a25-4edd-99f4-cdfebdc90879","command":"kimi -r session_769ddab9-0a25-4edd-99f4-cdfebdc90879","content":"To resume this session: kimi -r session_769ddab9-0a25-4edd-99f4-cdfebdc90879"}',
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);

    expect(parsed.summary).toBe("PAPERCLIP_ADAPTER_TEST_OK");
    expect(parsed.sessionId).toBe("session_769ddab9-0a25-4edd-99f4-cdfebdc90879");
    expect(parsed.errorMessage).toBeNull();
  });

  it("parses tool calls with JSON-encoded arguments strings", () => {
    const stdout = [
      '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_8c1OWyRBe68OMTbWY6NqnkMm","function":{"name":"Read","arguments":"{\\"path\\":\\"probe.txt\\"}"}}]}',
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);

    expect(parsed.toolCalls).toEqual([
      { id: "tool_8c1OWyRBe68OMTbWY6NqnkMm", name: "Read", arguments: { path: "probe.txt" } },
    ]);
    expect(parsed.summary).toBe("");
  });

  it("keeps raw arguments when the string is not valid JSON", () => {
    const stdout = [
      '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_1","function":{"name":"Bash","arguments":"not json"}}]}',
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);

    expect(parsed.toolCalls).toEqual([
      { id: "tool_1", name: "Bash", arguments: "not json" },
    ]);
  });

  it("collects tool results keyed by tool_call_id", () => {
    const stdout = [
      '{"role":"assistant","tool_calls":[{"type":"function","id":"tool_8c1OWyRBe68OMTbWY6NqnkMm","function":{"name":"Read","arguments":"{\\"path\\":\\"probe.txt\\"}"}}]}',
      '{"role":"tool","tool_call_id":"tool_8c1OWyRBe68OMTbWY6NqnkMm","content":"1\\thello paperclip"}',
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);

    expect(parsed.toolResults).toEqual([
      { toolCallId: "tool_8c1OWyRBe68OMTbWY6NqnkMm", content: "1\thello paperclip" },
    ]);
  });

  it("captures the session id from the trailing meta resume hint", () => {
    const stdout = [
      '{"role":"assistant","content":"done"}',
      '{"role":"meta","type":"session.resume_hint","session_id":"session_abc","command":"kimi -r session_abc","content":"To resume this session: kimi -r session_abc"}',
    ].join("\n");

    expect(parseKimiJsonl(stdout).sessionId).toBe("session_abc");
  });

  it("joins multiple assistant messages with blank lines", () => {
    const stdout = [
      '{"role":"assistant","content":"first"}',
      '{"role":"assistant","content":"second"}',
    ].join("\n");

    expect(parseKimiJsonl(stdout).summary).toBe("first\n\nsecond");
  });

  it("skips malformed lines without failing the parse", () => {
    const stdout = [
      "not json at all",
      '{"role":"assistant","content":"visible"}',
      "{broken json",
      "",
    ].join("\n");

    const parsed = parseKimiJsonl(stdout);

    expect(parsed.summary).toBe("visible");
    expect(parsed.sessionId).toBeNull();
  });

  it("ignores meta events without a session id", () => {
    const stdout = '{"role":"meta","type":"some.other_meta","content":"noise"}';
    expect(parseKimiJsonl(stdout).sessionId).toBeNull();
  });
});

describe("detectKimiAuthRequired", () => {
  it("flags device-flow login hints", () => {
    const result = detectKimiAuthRequired({
      stdout: "",
      stderr: "Not authenticated. Run `kimi login` to authenticate with a device code.",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("flags 401 unauthorized responses", () => {
    const result = detectKimiAuthRequired({
      stdout: "",
      stderr: "Error: 401 Unauthorized",
    });
    expect(result.requiresAuth).toBe(true);
  });

  it("does not flag ordinary output", () => {
    const result = detectKimiAuthRequired({
      stdout: '{"role":"assistant","content":"hello"}',
      stderr: "",
    });
    expect(result.requiresAuth).toBe(false);
  });
});

describe("isKimiTransientNetworkError", () => {
  it("matches DNS failures", () => {
    expect(isKimiTransientNetworkError("", "Error: getaddrinfo ENOTFOUND api.moonshot.cn")).toBe(true);
  });

  it("matches EAI_AGAIN", () => {
    expect(isKimiTransientNetworkError("", "getaddrinfo EAI_AGAIN api.moonshot.cn")).toBe(true);
  });

  it("matches fetch failed", () => {
    expect(isKimiTransientNetworkError("", "TypeError: fetch failed")).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(isKimiTransientNetworkError("", "Some other error")).toBe(false);
  });
});

describe("isKimiSessionUnrecoverableError", () => {
  it("matches unknown session", () => {
    expect(isKimiSessionUnrecoverableError("", "Error: unknown session 'session_abc'")).toBe(true);
  });

  it("matches session not found", () => {
    expect(isKimiSessionUnrecoverableError("", "session session_abc not found on disk")).toBe(true);
  });

  it("matches failed to resume", () => {
    expect(isKimiSessionUnrecoverableError("", "failed to resume session session_abc")).toBe(true);
  });

  it("does not match unrelated stderr", () => {
    expect(isKimiSessionUnrecoverableError("", "Some other error")).toBe(false);
  });

  it("does not match transient network errors (those go to isKimiTransientNetworkError)", () => {
    expect(isKimiSessionUnrecoverableError("", "Error: getaddrinfo ENOTFOUND api.moonshot.cn")).toBe(false);
  });
});
