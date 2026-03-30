import { describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "../adapters/types.js";
import { buildPrompt, extractStreamJsonResult, resolveRuntimeCommand, shellEscape } from "../adapters/cloud-sandbox/execute.js";

function buildContext(
  config: Record<string, unknown>,
  context: Record<string, unknown> = {},
  overrides?: Partial<AdapterExecutionContext>,
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-abc",
      companyId: "company-xyz",
      name: "CEO",
      adapterType: "cloud_sandbox",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context,
    onLog: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// shellEscape
// ---------------------------------------------------------------------------
describe("shellEscape", () => {
  it("wraps in single quotes", () => {
    expect(shellEscape("hello")).toBe("'hello'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellEscape("it's")).toBe("'it'\\''s'");
  });

  it("handles multi-line strings", () => {
    const escaped = shellEscape("line1\nline2");
    expect(escaped).toBe("'line1\nline2'");
  });
});

// ---------------------------------------------------------------------------
// buildPrompt
// ---------------------------------------------------------------------------
describe("buildPrompt", () => {
  it("returns the default heartbeat prompt when config has no templates", async () => {
    const ctx = buildContext({ runtime: "opencode" });
    const prompt = await buildPrompt(ctx);
    expect(prompt).toBe("You are agent agent-abc (CEO). Continue your Paperclip work.");
  });

  it("renders a custom promptTemplate with template variables", async () => {
    const ctx = buildContext({
      promptTemplate: "Agent {{agent.name}} in company {{companyId}}, run {{runId}}.",
    });
    const prompt = await buildPrompt(ctx);
    expect(prompt).toBe("Agent CEO in company company-xyz, run run-123.");
  });

  it("includes bootstrapPromptTemplate before heartbeat prompt", async () => {
    const ctx = buildContext({
      bootstrapPromptTemplate: "Welcome {{agent.name}}, you are a Paperclip agent.",
      promptTemplate: "Continue working.",
    });
    const prompt = await buildPrompt(ctx);
    expect(prompt).toContain("Welcome CEO, you are a Paperclip agent.");
    expect(prompt).toContain("Continue working.");
    // Bootstrap comes first
    const bootstrapIdx = prompt!.indexOf("Welcome CEO");
    const heartbeatIdx = prompt!.indexOf("Continue working");
    expect(bootstrapIdx).toBeLessThan(heartbeatIdx);
  });

  it("includes issue context as a structured section", async () => {
    const ctx = buildContext(
      { runtime: "opencode" },
      { issueTitle: "Fix the login bug", issueDescription: "Users can't log in after password reset." },
    );
    const prompt = await buildPrompt(ctx);
    expect(prompt).toContain("## Current Task");
    expect(prompt).toContain("Fix the login bug");
    expect(prompt).toContain("Users can't log in after password reset.");
  });

  it("includes session handoff markdown", async () => {
    const ctx = buildContext(
      { runtime: "opencode" },
      { paperclipSessionHandoffMarkdown: "Previous session summary: fixed 3 bugs." },
    );
    const prompt = await buildPrompt(ctx);
    expect(prompt).toContain("Previous session summary: fixed 3 bugs.");
  });

  it("composes all sections in the correct order", async () => {
    const ctx = buildContext(
      {
        bootstrapPromptTemplate: "BOOTSTRAP",
        promptTemplate: "HEARTBEAT",
      },
      {
        paperclipSessionHandoffMarkdown: "HANDOFF",
        issueTitle: "TASK_TITLE",
        issueDescription: "TASK_DESC",
      },
    );
    const prompt = (await buildPrompt(ctx))!;
    const bootstrapIdx = prompt.indexOf("BOOTSTRAP");
    const handoffIdx = prompt.indexOf("HANDOFF");
    const taskIdx = prompt.indexOf("TASK_TITLE");
    const heartbeatIdx = prompt.indexOf("HEARTBEAT");

    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(handoffIdx).toBeGreaterThan(bootstrapIdx);
    expect(taskIdx).toBeGreaterThan(handoffIdx);
    expect(heartbeatIdx).toBeGreaterThan(taskIdx);
  });

  it("skips empty sections gracefully", async () => {
    const ctx = buildContext({
      bootstrapPromptTemplate: "",
      promptTemplate: "Do your work.",
    });
    const prompt = await buildPrompt(ctx);
    expect(prompt).toBe("Do your work.");
    // No double newlines from empty sections
    expect(prompt).not.toContain("\n\n\n");
  });

  it("falls back to default heartbeat prompt even when promptTemplate is empty string", async () => {
    // asString treats "" as falsy and returns the default
    const ctx = buildContext({ promptTemplate: "" });
    const prompt = await buildPrompt(ctx);
    expect(prompt).toBe("You are agent agent-abc (CEO). Continue your Paperclip work.");
  });

  it("handles issue with only a title (no description)", async () => {
    const ctx = buildContext(
      { promptTemplate: "Work." },
      { issueTitle: "Deploy v2", issueDescription: "" },
    );
    const prompt = (await buildPrompt(ctx))!;
    expect(prompt).toContain("## Current Task\nDeploy v2");
    expect(prompt).toContain("Work.");
  });

  it("handles issue with only a description (no title)", async () => {
    const ctx = buildContext(
      { promptTemplate: "Work." },
      { issueTitle: "", issueDescription: "Migrate the database schema." },
    );
    const prompt = (await buildPrompt(ctx))!;
    expect(prompt).toContain("Migrate the database schema.");
    expect(prompt).not.toContain("## Current Task");
  });
});

// ---------------------------------------------------------------------------
// resolveRuntimeCommand
// ---------------------------------------------------------------------------
describe("resolveRuntimeCommand", () => {
  it("builds opencode command with prompt via -p flag and -q for quiet mode", () => {
    const cmd = resolveRuntimeCommand("opencode", "", "Do the work");
    expect(cmd).toEqual(["opencode", "-p", "'Do the work'", "-f", "json", "-q"]);
  });

  it("uses fallback prompt when none is provided", () => {
    const cmd = resolveRuntimeCommand("opencode", "", undefined);
    expect(cmd).toEqual([
      "opencode", "-p", "'Complete your assigned tasks.'", "-f", "json", "-q",
    ]);
  });

  it("builds codex command with model", () => {
    const cmd = resolveRuntimeCommand("codex", "gpt-4o");
    expect(cmd).toEqual(["codex", "--full-auto", "--model", "gpt-4o"]);
  });

  it("handles multi-line prompt with shell escaping", () => {
    const prompt = "Line 1\n\nLine 2";
    const cmd = resolveRuntimeCommand("opencode", "", prompt);
    expect(cmd[2]).toBe("'Line 1\n\nLine 2'");
    expect(cmd).toContain("-q");
  });

  it("handles prompt with single quotes", () => {
    const prompt = "It's a test";
    const cmd = resolveRuntimeCommand("opencode", "", prompt);
    expect(cmd[2]).toBe("'It'\\''s a test'");
  });

  it("does not add -q for non-opencode runtimes", () => {
    const cmd = resolveRuntimeCommand("codex", "model");
    expect(cmd).not.toContain("-q");
  });
});

// ---------------------------------------------------------------------------
// extractStreamJsonResult
// ---------------------------------------------------------------------------
describe("extractStreamJsonResult", () => {
  it("extracts the result event from JSON stream output", () => {
    const stdout = [
      '{"type":"init","session_id":"sess-1"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"}]}}',
      '{"type":"result","result":"Done","is_error":false}',
    ].join("\n");
    const result = extractStreamJsonResult(stdout);
    expect(result).toEqual({ type: "result", result: "Done", is_error: false });
  });

  it("returns null when no result event exists", () => {
    const stdout = '{"type":"assistant","message":{"content":[]}}\n';
    expect(extractStreamJsonResult(stdout)).toBeNull();
  });

  it("returns null for empty output", () => {
    expect(extractStreamJsonResult("")).toBeNull();
  });

  it("skips non-JSON lines", () => {
    const stdout = "some plain text\n" +
      '{"type":"result","result":"ok"}\n';
    const result = extractStreamJsonResult(stdout);
    expect(result).toEqual({ type: "result", result: "ok" });
  });

  it("returns the last result event if multiple exist", () => {
    const stdout = [
      '{"type":"result","result":"first"}',
      '{"type":"result","result":"last"}',
    ].join("\n");
    const result = extractStreamJsonResult(stdout);
    expect(result).toEqual({ type: "result", result: "last" });
  });
});

// ---------------------------------------------------------------------------
// End-to-end prompt composition (realistic scenarios)
// ---------------------------------------------------------------------------
describe("buildPrompt realistic scenarios", () => {
  it("CEO agent with an assigned issue produces a rich prompt", async () => {
    const ctx = buildContext(
      {
        runtime: "opencode",
        bootstrapPromptTemplate:
          "You are {{agent.name}}, the chief executive of company {{companyId}}.\n" +
          "Use the Paperclip API at $PAPERCLIP_API_URL to manage your company.",
        promptTemplate:
          "Review the current task and take action. Run ID: {{runId}}.",
      },
      {
        issueTitle: "Hire a CTO",
        issueDescription: "We need a CTO to lead the engineering team. Review candidates and make a recommendation.",
        paperclipSessionHandoffMarkdown: "",
      },
    );
    const prompt = (await buildPrompt(ctx))!;

    // Contains rendered bootstrap
    expect(prompt).toContain("You are CEO, the chief executive of company company-xyz.");
    expect(prompt).toContain("Use the Paperclip API");
    // Contains issue
    expect(prompt).toContain("## Current Task\nHire a CTO");
    expect(prompt).toContain("We need a CTO");
    // Contains heartbeat
    expect(prompt).toContain("Review the current task and take action. Run ID: run-123.");
  });

  it("agent with minimal config (like the live CEO) gets a usable default", async () => {
    // This mirrors the actual CEO config: { "env": {...}, "runtime": "opencode" }
    const ctx = buildContext(
      { runtime: "opencode", env: { ANTHROPIC_API_KEY: "sk-..." } },
      { issueTitle: "Set up the company", issueDescription: "Initialize company operations." },
    );
    const prompt = (await buildPrompt(ctx))!;

    // Should still get a useful prompt from the defaults
    expect(prompt).toContain("## Current Task\nSet up the company");
    expect(prompt).toContain("Initialize company operations.");
    expect(prompt).toContain("You are agent agent-abc (CEO). Continue your Paperclip work.");
  });

  it("agent with no issue still gets identity prompt", async () => {
    const ctx = buildContext(
      { runtime: "opencode" },
      {}, // no issue context
    );
    const prompt = (await buildPrompt(ctx))!;
    expect(prompt).toBe("You are agent agent-abc (CEO). Continue your Paperclip work.");
  });
});

// ---------------------------------------------------------------------------
// Output format compatibility
// ---------------------------------------------------------------------------
describe("extractStreamJsonResult format compatibility", () => {
  it("handles opencode -p -f json format (single pretty-printed object)", () => {
    // opencode -p outputs a pretty-printed JSON object, not JSONL
    const stdout = '{\n  "response": "I completed the task."\n}\n';
    // extractStreamJsonResult only finds {type:"result"} events
    // so this format returns null (handled by post-exec parsing instead)
    expect(extractStreamJsonResult(stdout)).toBeNull();
  });

  it("handles opencode JSONL stream format", () => {
    const stdout = [
      '{"type":"text","part":{"text":"Working on it..."}}',
      '{"type":"step_finish","part":{"tokens":{"input":100,"output":50,"cache":{"read":0}},"cost":0.001}}',
      '{"type":"text","part":{"text":"Done!"}}',
    ].join("\n");
    // extractStreamJsonResult only finds {type:"result"} events
    expect(extractStreamJsonResult(stdout)).toBeNull();
  });

  it("handles opencode error in JSONL format", () => {
    const stdout = '{"type":"error","error":"authentication_error","message":"invalid api key"}\n';
    expect(extractStreamJsonResult(stdout)).toBeNull();
  });
});
