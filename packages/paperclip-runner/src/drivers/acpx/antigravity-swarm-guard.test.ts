import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerFailureFromError } from "../provider-failure.js";
import { AntigravitySwarmError } from "./antigravity-swarm-guard.js";
import {
  antigravitySwarmModelName, antigravitySwarmWorkspaceEscape, classifyAntigravityRefusalText, createAntigravitySwarmGuard,
} from "./antigravity-swarm-guard.js";

const WORKSPACE = "/work/task";
// Real `session/new` results from the pinned CLI on one paid Google sign-in (2026-11-24).
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../test-fixtures/antigravity-cli/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const STABLE_ENDPOINT_SESSION = fixture("session-new.stable-endpoint.json");
const DAILY_ENDPOINT_SESSION = fixture("session-new.daily-endpoint.json");
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

  it("carries its plain message to the user as a typed provider failure, without a code", () => {
    const error = new AntigravitySwarmError("ANTIGRAVITY_SWARM_SIGN_IN_REQUIRED", "The Antigravity CLI on this computer is not signed in to Google.");
    const failure = providerFailureFromError(new Error("session.open failed", { cause: error }));
    expect(failure).toMatchObject({
      provider: "antigravity", phase: "startup", category: "authentication",
      message: "The Antigravity CLI on this computer is not signed in to Google.",
    });
    expect(failure).not.toHaveProperty("providerCode");
    expect(new AntigravitySwarmError("ANTIGRAVITY_SWARM_UNAVAILABLE", "x").providerFailure).toMatchObject({ category: "invalid_request", retryability: "requires_action" });
  });

  describe("model selection against the CLI's real model lists", () => {
    const open = (model: string, session: Record<string, unknown>) => {
      const guard = createAntigravitySwarmGuard({ model, instructions: INSTRUCTIONS, workspace: WORKSPACE });
      guard.initialize(initializeResult());
      guard.sessionRequest(sessionRequest());
      guard.sessionResult(session);
      return guard;
    };

    it("refuses Gemini 4 Neon on the stable endpoint in one plain sentence, naming no code, and keeps the offered list for diagnostics", () => {
      let refusal: unknown;
      try { open("gemini-4-neon-low", STABLE_ENDPOINT_SESSION); } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(AntigravitySwarmError);
      const error = refusal as AntigravitySwarmError;
      expect(error.code).toBe("ANTIGRAVITY_SWARM_UNAVAILABLE");
      expect(error.message).toBe("Swarm is not available with Gemini 4 Neon (Low) yet, so nothing was changed: choose another model for this agent, such as Gemini 4 Argon, and send /swarm again.");
      expect(error.message).not.toMatch(/gemini-4-neon|ANTIGRAVITY_|sign-in/);
      expect(error.providerFailure).toMatchObject({ category: "model_unavailable", retryability: "requires_action", message: error.message });
      expect(error.providerFailure).not.toHaveProperty("providerCode");
      expect(error.diagnostic).toMatch(/^The Antigravity CLI offered 13 models and not gemini-4-neon-low: gemini-4-argon-medium, /);
      expect(error.diagnostic).toContain("gpt-oss-120b-medium");
    });

    it("names the fix when the deployment pinned Google's stable channel", () => {
      const guard = createAntigravitySwarmGuard({ model: "gemini-4-neon-low", instructions: INSTRUCTIONS, workspace: WORKSPACE, channel: "stable" });
      guard.initialize(initializeResult());
      guard.sessionRequest(sessionRequest());
      expect(() => guard.sessionResult(STABLE_ENDPOINT_SESSION)).toThrow(
        "Swarm is not available with Gemini 4 Neon (Low) on Google's stable channel, so nothing was changed: an admin can switch swarms to Google's default channel, or choose another model for this agent, such as Gemini 4 Argon, and send /swarm again.");
    });

    it("admits every Neon level the daily endpoint lists, reading family and thinking level back separately", () => {
      for (const [level, cliLevel] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"]]) {
        const guard = open(`gemini-4-neon-${level}`, DAILY_ENDPOINT_SESSION);
        guard.observe({ sessionId: SESSION, update: { sessionUpdate: "current_mode_update", currentModeId: "auto" } });
        guard.bindMode();
        guard.observe(config("gemini-4-neon", cliLevel!));
        guard.bindModel();
        expect(guard.receipt()).toMatchObject({ model: `gemini-4-neon-${level}`, modelFamily: "gemini-4-neon", thoughtLevel: cliLevel,
          agentVersion: "1.5.15", modelName: expect.stringMatching(/^Gemini 4 Neon \((Low|Medium|High|XHigh)\)$/) });
      }
    });

    it("admits a model the stable endpoint lists, with the CLI's own name", () => {
      const guard = open("gemini-4-argon-low", STABLE_ENDPOINT_SESSION);
      guard.observe({ sessionId: SESSION, update: { sessionUpdate: "current_mode_update", currentModeId: "auto" } });
      guard.bindMode();
      guard.observe(config("gemini-4-argon", "low"));
      guard.bindModel();
      expect(guard.receipt()).toMatchObject({ modelName: "Gemini 4 Argon (Low)", modelFamily: "gemini-4-argon", thoughtLevel: "low" });
    });

    it("names a model the CLI does not list in plain words", () => {
      expect(antigravitySwarmModelName("gemini-4-neon-xhigh")).toBe("Gemini 4 Neon (Extra high)");
      expect(antigravitySwarmModelName("claude-opus-5-5-high")).toBe("Claude Opus 5.5 (High)");
      expect(antigravitySwarmModelName("gemini-3.8-flash-low")).toBe("Gemini 3.8 Flash (Low)");
    });
  });
});
