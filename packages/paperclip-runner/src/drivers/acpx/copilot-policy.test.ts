import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COPILOT_AGENT_MODE, assertCopilotConfigPolicy, assertCopilotControlPolicy,
  assertCopilotPromptPolicy, assertCopilotSessionPolicy, assertCopilotSessionUpdatePolicy,
  createCopilotProtocolGuard,
} from "./copilot-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/copilot-acp-denial-1.0.88.json", import.meta.url), "utf8"));
const session = fixture.wire.find((message: { result?: { modes?: unknown } }) => message.result?.modes).result;

describe("Copilot native policy fence", () => {
  it("admits the pinned real-binary agent/manual snapshot", () => {
    expect(() => assertCopilotSessionPolicy(session)).not.toThrow();
    expect(() => assertCopilotSessionUpdatePolicy({ sessionUpdate: "config_option_update", configOptions: session.configOptions })).not.toThrow();
  });
  it.each(["/yolo on", " /allow-all", "\n/autopilot", "\t/plan", "\ufeff/cwd /elsewhere", "/unknown-future-command", "/custom-skill"])("rejects native command dispatch %s", text => {
    expect(() => assertCopilotPromptPolicy(text)).toThrowError(expect.objectContaining({ code: "COPILOT_POLICY_VIOLATION", retryable: false }));
  });
  it.each(["tool_call", "tool_call_update"])("rejects native detach independent of tool name in %s", sessionUpdate => {
    for (const tool of ["bash", "write_bash", "powershell", "unknown"]) {
      expect(() => assertCopilotSessionUpdatePolicy({ sessionUpdate, tool, rawInput: { detach: true } }))
        .toThrowError(expect.objectContaining({ code: "COPILOT_DETACHED_WORK_UNSUPPORTED", retryable: false }));
      expect(() => assertCopilotSessionUpdatePolicy({ sessionUpdate, tool, rawInput: { mode: "async", detach: false } })).not.toThrow();
    }
  });
  it("preserves ordinary prose mentioning commands and natural-language questions", () => {
    for (const text of ["Explain /plan", "Ask me before proceeding", "Read this file: /workspace/file", "Plan the work\n/yolo on"]) {
      expect(() => assertCopilotPromptPolicy(text)).not.toThrow();
    }
  });
  it.each([undefined, null, {}, { modes: session.modes }, { configOptions: session.configOptions },
    { ...session, modes: { currentModeId: "https://agentclientprotocol.com/protocol/session-modes#autopilot" } },
    { ...session, modes: { currentModeId: "https://agentclientprotocol.com/protocol/session-modes#plan" } },
  ])("rejects missing or unsafe connection proof", state => {
    expect(() => assertCopilotSessionPolicy(state)).toThrow(/admitted permission policy/);
  });
  it("rejects bypass, duplicate, missing, custom-agent and future config authority", () => {
    const config = session.configOptions;
    for (const value of [[], [...config, config[0]], config.filter((option: { id: string }) => option.id !== "allow_all"),
      config.map((option: { id: string }) => option.id === "allow_all" ? { ...option, currentValue: "on" } : option),
      [...config, { id: "agent", currentValue: "privileged-agent" }], [...config, { id: "new-authority", currentValue: "off" }]]) {
      expect(() => assertCopilotConfigPolicy(value)).toThrow(/admitted permission policy/);
    }
  });
  it("only permits selecting the admitted explicit model", () => {
    expect(() => assertCopilotControlPolicy("session/set_model", { modelId: "gpt-5.6-luna" }, "gpt-5.6-luna")).not.toThrow();
    expect(() => assertCopilotControlPolicy("session/set_config_option", { configId: "model", value: "gpt-5.6-luna" }, "gpt-5.6-luna")).not.toThrow();
    for (const [method, params] of [["session/set_mode", { modeId: COPILOT_AGENT_MODE }],
      ["session/set_config_option", { configId: "allow_all", value: "on" }],
      ["session/set_config_option", { configId: "mode", value: COPILOT_AGENT_MODE }],
      ["session/set_model", { modelId: "auto" }], ["session/set_model", { modelId: "other" }]] as const) {
      expect(() => assertCopilotControlPolicy(method, params, "gpt-5.6-luna")).toThrow(/admitted permission policy/);
    }
  });
  it("rejects policy drift without logging provider strings", () => {
    expect(() => assertCopilotSessionUpdatePolicy({ sessionUpdate: "current_mode_update", currentModeId: "secret-provider-value" }))
      .toThrowError(expect.objectContaining({ message: expect.not.stringContaining("secret-provider-value") }));
    expect(() => assertCopilotSessionUpdatePolicy({ sessionUpdate: "current_mode_update", currentModeId: COPILOT_AGENT_MODE })).not.toThrow();
    expect(() => assertCopilotSessionUpdatePolicy({ sessionUpdate: "config_option_update" })).toThrow();
  });
});

describe("Copilot connection authority", () => {
  const safe = { ...session, sessionId: "s", configOptions: [...session.configOptions, { id: "model", currentValue: "gpt-5.6-luna" }] };
  const request = (guard: ReturnType<typeof createCopilotProtocolGuard>, method: string, params: unknown, id = 0) => guard("outbound", { jsonrpc: "2.0", id, method, params });
  const admit = (guard: ReturnType<typeof createCopilotProtocolGuard>, method = "session/new") => {
    request(guard, method, method === "session/new" ? {} : { sessionId: "s" });
    guard("inbound", { id: 0, result: safe });
  };
  it.each(["session/new", "session/load", "session/resume"])("requires fresh safe %s response on each connection", method => {
    const guard = createCopilotProtocolGuard("gpt-5.6-luna");
    admit(guard, method);
    expect(() => request(guard, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "Complete task" }] }, 1)).not.toThrow();
    const reconnected = createCopilotProtocolGuard("gpt-5.6-luna");
    expect(() => request(reconnected, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "Complete task" }] })).toThrow();
  });
  it("invalidates authority permanently when resumed policy or current policy drifts", () => {
    for (const bad of [{ sessionUpdate: "current_mode_update", currentModeId: "autopilot" }, { sessionUpdate: "config_option_update", configOptions: [] }]) {
      const guard = createCopilotProtocolGuard("gpt-5.6-luna"); admit(guard);
      expect(() => guard("inbound", { method: "session/update", params: { sessionId: "s", update: bad } })).toThrow();
      expect(() => guard("inbound", { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", configOptions: safe.configOptions } } })).toThrow();
    }
  });
  it("also denies detachment carried only by permission rawInput", () => {
    const guard = createCopilotProtocolGuard("gpt-5.6-luna"); admit(guard);
    expect(() => guard("inbound", { id: 0, method: "session/request_permission", params: { sessionId: "s", toolCall: { rawInput: { detach: true } } } }))
      .toThrowError(expect.objectContaining({ code: "COPILOT_DETACHED_WORK_UNSUPPORTED" }));
    expect(() => guard("outbound", { id: 0, result: { outcome: { outcome: "selected", optionId: "allow_once" } } }))
      .toThrowError(expect.objectContaining({ code: "COPILOT_DETACHED_WORK_UNSUPPORTED" }));
  });
  it("does not turn native unresolved input into delivered answers or successful continuation", () => {
    for (const type of ["user_input.requested", "exit_plan_mode.requested", "elicitation.requested"]) {
      const guard = createCopilotProtocolGuard("gpt-5.6-luna"); admit(guard);
      expect(() => guard("inbound", { method: "github.com/copilot/sessionEvent", params: { sessionId: "s", type, data: { requestId: 0 } } })).toThrow();
    }
  });
  it("requires the selected model before prompting, including reconnect", () => {
    const guard = createCopilotProtocolGuard("gpt-5.6-luna"); request(guard, "session/load", { sessionId: "s" });
    guard("inbound", { id: 0, result: session });
    expect(() => request(guard, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: "Run" }] }, 1)).toThrow();
  });
  it("validates the joined wire text and preserves zero request IDs", () => {
    const guard = createCopilotProtocolGuard("gpt-5.6-luna"); admit(guard);
    expect(() => request(guard, "session/prompt", { sessionId: "s", prompt: [{ type: "text", text: " " }, { type: "text", text: "/yolo on" }] })).toThrow();
  });
});
