import { describe, expect, it } from "vitest";
import {
  antigravitySwarmWorkspaceEscape, classifyAntigravityRefusalText, createAntigravitySwarmGuard,
} from "./antigravity-swarm-guard.js";

const WORKSPACE = "/work/task";
const INSTRUCTIONS = "Paperclip instructions";
const SESSION = "s-1";

function initializeResult(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } },
    agentInfo: { name: "Antigravity ACP Server", version: "1.5.15" },
    ...overrides,
  };
}

function sessionResult(modes = ["default", "accept-edits", "auto", "plan"]) {
  return {
    sessionId: SESSION,
    modes: { currentModeId: "default", availableModes: modes.map(id => ({ id })) },
    models: { currentModelId: "gemini-4-argon-medium", availableModels: [{ modelId: "gemini-4-argon-medium" }, { modelId: "gemini-3.8-flash-low" }] },
    configOptions: [
      { id: "model", currentValue: "gemini-4-argon" }, { id: "thought_level", currentValue: "medium" }, { id: "mode", currentValue: "default" },
    ],
  };
}

const sessionRequest = (overrides: Record<string, unknown> = {}) => ({
  cwd: WORKSPACE,
  mcpServers: [{ type: "http", name: "paperclip", url: "http://127.0.0.1:1/mcp", headers: [] }],
  _meta: { antigravity: { systemPrompt: { append: INSTRUCTIONS } } },
  ...overrides,
});

const config = (model: string, level: string, mode = "auto") => ({
  sessionId: SESSION,
  update: { sessionUpdate: "config_option_update", configOptions: [
    { id: "model", currentValue: model }, { id: "thought_level", currentValue: level }, { id: "mode", currentValue: mode },
  ] },
});

function admitted() {
  const guard = createAntigravitySwarmGuard({ model: "gemini-3.8-flash-low", instructions: INSTRUCTIONS, workspace: WORKSPACE });
  guard.initialize(initializeResult());
  guard.sessionRequest(sessionRequest());
  guard.sessionResult(sessionResult());
  guard.observe({ sessionId: SESSION, update: { sessionUpdate: "current_mode_update", currentModeId: "auto" } });
  guard.bindMode();
  guard.observe(config("gemini-3.8-flash", "low"));
  guard.bindModel();
  return guard;
}

describe("Antigravity CLI swarm guard (replaces the registry admission receipt)", () => {
  it("records a receipt when identity, workspace, tools, instructions, auto mode and model all read back", () => {
    expect(admitted().receipt()).toMatchObject({
      agentName: "Antigravity ACP Server", agentVersion: "1.5.15", sessionId: SESSION, workspace: WORKSPACE,
      mode: "auto", model: "gemini-3.8-flash-low", modelFamily: "gemini-3.8-flash", thoughtLevel: "low", mcpServers: ["paperclip"],
    });
  });

  it("refuses a CLI that is not the pinned identity or cannot take Paperclip's instructions", () => {
    const guard = () => createAntigravitySwarmGuard({ model: "gemini-3.8-flash-low", instructions: INSTRUCTIONS, workspace: WORKSPACE });
    expect(() => guard().initialize(initializeResult({ agentInfo: { name: "Antigravity ACP Server", version: "1.5.16" } })))
      .toThrow(expect.objectContaining({ code: "ANTIGRAVITY_SWARM_RECEIPT_MISMATCH" }));
    expect(() => guard().initialize(initializeResult({ agentInfo: { name: "antigravity-acp", version: "1.5.15" } }))).toThrow(/pinned version/);
    expect(() => guard().initialize(initializeResult({ agentCapabilities: {} }))).toThrow(/instructions/);
  });

  it("refuses a session outside the task folder, with extra tool servers, or without the instructions", () => {
    const fresh = () => {
      const guard = createAntigravitySwarmGuard({ model: "gemini-3.8-flash-low", instructions: INSTRUCTIONS, workspace: WORKSPACE });
      guard.initialize(initializeResult());
      return guard;
    };
    expect(() => fresh().sessionRequest(sessionRequest({ cwd: "/elsewhere" }))).toThrow(/task folder/);
    expect(() => fresh().sessionRequest(sessionRequest({ mcpServers: [
      { type: "http", name: "paperclip", url: "u", headers: [] }, { name: "extra", command: "/bin/x", args: [], env: [] },
    ] }))).toThrow(/Paperclip's own tools/);
    expect(() => fresh().sessionRequest(sessionRequest({ _meta: {} }))).toThrow(/instructions/);
  });

  it("names a sign-in without auto mode as unavailable instead of running without helper writes", () => {
    const guard = createAntigravitySwarmGuard({ model: "gemini-3.8-flash-low", instructions: INSTRUCTIONS, workspace: WORKSPACE });
    guard.initialize(initializeResult());
    guard.sessionRequest(sessionRequest());
    expect(() => guard.sessionResult(sessionResult(["default", "accept-edits", "plan"])))
      .toThrow(expect.objectContaining({ code: "ANTIGRAVITY_SWARM_UNAVAILABLE" }));
  });

  it("fails closed when mode or model does not read back, or changes afterwards", () => {
    const base = () => {
      const guard = createAntigravitySwarmGuard({ model: "gemini-3.8-flash-low", instructions: INSTRUCTIONS, workspace: WORKSPACE });
      guard.initialize(initializeResult());
      guard.sessionRequest(sessionRequest());
      guard.sessionResult(sessionResult());
      return guard;
    };
    expect(() => base().bindMode()).toThrow(/auto mode/);
    const wrongLevel = base();
    wrongLevel.observe(config("gemini-3.8-flash", "high"));
    expect(() => wrongLevel.bindModel()).toThrow(/gemini-3.8-flash-low/);
    expect(() => admitted().observe(config("gemini-3.8-flash", "high"))).toThrow(/changed/);
    expect(() => admitted().observe({ sessionId: SESSION, update: { sessionUpdate: "current_mode_update", currentModeId: "default" } })).toThrow(/changed/);
  });

  it("refuses a helper that would get its own copy of the workspace", () => {
    const add = (workspace?: string) => ({ sessionUpdate: "tool_call", name: "swarm",
      args: { action: "add", name: "writer-a", ...(workspace === undefined ? {} : { workspace }) } });
    expect(antigravitySwarmWorkspaceEscape(add())).toBeNull();
    expect(antigravitySwarmWorkspaceEscape(add("inherit"))).toBeNull();
    expect(antigravitySwarmWorkspaceEscape(add("branch"))).toBe("writer-a");
    expect(antigravitySwarmWorkspaceEscape(add("share"))).toBe("writer-a");
  });

  it("treats provider refusals that arrive as ordinary text as failures", () => {
    expect(classifyAntigravityRefusalText("⚠ agent executor error: Error 402 Your prepayment credits are depleted. Status: RESOURCE_EXHAUSTED"))
      .toMatchObject({ kind: "quota_exhausted", httpStatus: 402 });
    expect(classifyAntigravityRefusalText("\n⚠ RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).\n"))
      .toMatchObject({ kind: "rate_limit", httpStatus: 429 });
    expect(classifyAntigravityRefusalText("Both files are written.")).toBeNull();
  });
});
