import { describe, expect, it } from "vitest";
import { paperclipRunnerUIAdapter } from "./index";

describe("paperclip runner transcript projection", () => {
  it("renders committed PRP semantic tool items with the existing chat parts", () => {
    const started = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event",
      event: {
        eventType: "item.started",
        payload: { item: { type: "tool_use", id: "call-1", name: "get_task_context", input: {} } },
      },
    }), "2026-08-21T12:00:00.000Z");
    const completed = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event",
      event: {
        eventType: "item.completed",
        payload: { item: { type: "tool_result", id: "call-1", tool_use_id: "call-1", result: { ok: true } } },
      },
    }), "2026-08-21T12:00:01.000Z");
    expect(started).toEqual([expect.objectContaining({ kind: "tool_call", name: "get_task_context", toolUseId: "call-1" })]);
    expect(completed).toEqual([expect.objectContaining({ kind: "tool_result", toolUseId: "call-1", isError: false })]);
  });

  it("maps native Codex deltas, camel-case tools, and usage into the shared chat transcript", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, itemId?: string) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, itemId, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("item.delta", { kind: "reasoning", text: "Inspecting the runner" }, "reason-1"))
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Inspecting the runner", delta: true, channel: "unknown" }]);
    expect(event("item.delta", { kind: "agentMessage", text: "Here is" }, "message-1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Here is", delta: true, channel: "unknown" }]);
    expect(event("item.started", {
      kind: "commandExecution",
      item: { id: "exec-1", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    }, "exec-1")).toEqual([
      expect.objectContaining({ kind: "tool_call", name: "command", toolUseId: "exec-1" }),
    ]);
    expect(event("item.completed", {
      kind: "usage",
      usage: { total: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 80 } },
    })).toEqual([
      expect.objectContaining({ kind: "result", subtype: "paperclip.usage", inputTokens: 120, outputTokens: 30 }),
    ]);
  });

  it("emits a proposed and accepted terminal summary only once", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const line = (eventType: string, payload: Record<string, unknown>) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(line("run.result.proposed", { summary: "Finished the task" }))
      .toEqual([
        expect.objectContaining({ kind: "run_result", disposition: "done", summary: "Finished the task" }),
        { kind: "assistant", ts: expect.any(String), text: "Finished the task", channel: "final" },
      ]);
    expect(line("run.result.accepted", { result: { summary: "Finished the task" } }))
      .toEqual([]);
  });

  it("preserves progress, final-answer, and reasoning channels across item deltas", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, itemId: string) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, itemId, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("item.started", { kind: "agentMessage", channel: "progress", item: { id: "p1", type: "agentMessage", phase: "commentary", text: "" } }, "p1")).toEqual([]);
    expect(event("item.delta", { kind: "agentMessage", channel: "progress", text: "Running it now." }, "p1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Running it now.", delta: true, channel: "progress" }]);

    expect(event("item.started", { kind: "agentMessage", channel: "final", item: { id: "f1", type: "agentMessage", phase: "final_answer", text: "" } }, "f1")).toEqual([]);
    expect(event("item.delta", { kind: "agentMessage", channel: "final", text: "Completed." }, "f1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Completed.", delta: true, channel: "final" }]);

    expect(event("item.delta", { kind: "reasoning", channel: "summary", text: "Inspecting" }, "r1"))
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Inspecting", delta: true, channel: "summary" }]);
    expect(event("item.delta", { kind: "reasoning", channel: "detail", text: "Detailed trace" }, "r1"))
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Detailed trace", delta: true, channel: "detail" }]);
  });

  it("preserves empty reasoning lifecycle events as real thinking activity", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: {
        eventType,
        itemId: "reason-empty",
        payload: {
          kind: "reasoning",
          channel: "summary",
          item: { id: "reason-empty", type: "reasoning", text: "" },
        },
      },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("item.started")).toEqual([expect.objectContaining({
      kind: "thinking",
      text: "",
      lifecycle: "started",
      channel: "summary",
    })]);
    expect(event("item.completed")).toEqual([expect.objectContaining({
      kind: "thinking",
      text: "",
      lifecycle: "completed",
      channel: "summary",
    })]);
  });

  it("never exposes the structured task result envelope as final-response prose", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, itemId = "result-1") => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, itemId, payload },
    }), "2026-08-21T12:00:00.000Z");
    event("item.started", { kind: "agentMessage", channel: "final", item: { id: "result-1", type: "agentMessage", phase: "final_answer", text: "" } });
    expect(event("item.delta", { kind: "agentMessage", channel: "final", text: "{\"schema\":" })).toEqual([]);
    expect(event("item.delta", { kind: "agentMessage", channel: "final", text: "\"paperclip.run_result.v1\"}" })).toEqual([]);
    expect(event("run.result.proposed", { summary: "Human-readable completion." }))
      .toEqual([
        expect.objectContaining({ kind: "run_result", summary: "Human-readable completion." }),
        { kind: "assistant", ts: expect.any(String), text: "Human-readable completion.", channel: "final" },
      ]);
  });

  it("projects every canonical provider family as structured activity instead of JSON prose", () => {
    const cases = [
      ["plan.updated", "plan", { complete: true, explanation: "Ship safely" }],
      ["tool.execution.completed", "tool_execution", { status: "completed", name: "tests" }],
      ["research.completed", "research", { status: "completed", query: "PRP" }],
      ["delegation.completed", "delegation", { status: "completed", action: "spawn" }],
      ["model.route.changed", "model_identity", { provider: "claude", requestedModel: "claude", effectiveModel: "Claude Sonnet" }],
      ["context.compacted", "context", { reason: "window" }],
      ["artifact.generated", "artifact", { status: "completed", reference: "image.png" }],
      ["review.mode.changed", "review", { state: "entered" }],
      ["hook.completed", "hook", { status: "completed", event: "post-tool" }],
      ["memory.citation.referenced", "memory", { label: "Decision" }],
      ["safety.review.completed", "safety", { status: "completed", decision: "allowed" }],
      ["terminal.input.sent", "terminal", { byteCount: 1 }],
      ["wait.completed", "wait", { status: "completed", reason: "timer" }],
      ["provider.notice.recorded", "provider_notice", { summary: "Provider warning" }],
    ] as const;

    for (const [eventType, family, payload] of cases) {
      const entries = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
        type: "paperclip.prp.event",
        event: { eventType, payload },
      }), "2026-08-21T12:00:00.000Z");
      expect(entries, eventType).toEqual([expect.objectContaining({
        kind: "provider_activity",
        family,
        eventType,
      })]);
      expect(entries, eventType).not.toEqual([expect.objectContaining({ kind: "assistant" })]);
    }

    const modelRoute = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType: "model.route.changed", payload: { provider: "claude", requestedModel: "claude", effectiveModel: "Claude Sonnet" } },
    }), "2026-08-21T12:00:01.000Z");
    expect(modelRoute).toEqual([expect.objectContaining({ kind: "provider_activity", family: "model_identity", summary: "Claude Sonnet" })]);
  });

  it("projects workspace changes and verified file references as bounded structured entries", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("workspace.diff.recorded", {
      changeSetId: "changes-1",
      revision: 2,
      source: "runner_verified",
      complete: true,
      files: [{ path: "ui/src/App.tsx", operation: "modify", previousPath: null, additions: 3, deletions: 1, binary: false, diff: "+hello" }],
      totals: { files: 1, additions: 3, deletions: 1 },
      patchArtifactRef: null,
    })).toEqual([expect.objectContaining({ kind: "workspace_change", complete: true, source: "runner_verified" })]);

    expect(event("workspace.file.referenced", {
      referenceId: "file-1",
      source: "runner_verified",
      path: "doc/protocol.md",
      displayName: "protocol.md",
      mediaType: "text/markdown",
      presentation: "document",
      line: 12,
      preview: "# Protocol",
      previewTruncated: false,
      contentDigest: null,
    })).toEqual([expect.objectContaining({ kind: "workspace_file_reference", path: "doc/protocol.md", line: 12 })]);

    expect(event("workspace.file.referenced", {
      referenceId: "unsafe",
      path: "../secrets.env",
    })).toEqual([expect.objectContaining({ kind: "system", text: expect.stringContaining("unsafe") })]);
  });

  it("coalesces runtime request lifecycle data and emits terminal state", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, turnId = "turn-1") => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, turnId, payload },
    }), "2026-08-21T12:00:00.000Z");
    expect(event("runtime_request.created", { request: { requestId: "request-1", requestKind: "command_approval", type: "item/commandExecution/requestApproval", status: "pending", prompt: "Allow command?" } }))
      .toEqual([expect.objectContaining({
        kind: "runtime_request",
        requestKind: "command_approval",
        turnId: "turn-1",
        status: "pending",
        choices: [
          { key: "accept", label: "Allow once" },
          { key: "accept_for_session", label: "Allow for session" },
          { key: "decline", label: "Deny" },
          { key: "cancel", label: "Cancel" },
        ],
      })]);
    expect(event("runtime_request.resolved", { requestId: "request-1" }))
      .toEqual([expect.objectContaining({ kind: "runtime_request", status: "resolved", prompt: "Allow command?", requestKind: "command_approval", turnId: "turn-1" })]);
    expect(event("runtime_request.created", { request: { requestId: "request-2", requestKind: "runtime", type: "input", status: "pending", prompt: "Choose", input: { schema: "paperclip.question_set.v1", questions: [{ id: "environment", prompt: "Where?", required: true, answerMode: "single_select", options: [{ id: "staging", label: "Staging" }] }] } } }))
      .toEqual([expect.objectContaining({ kind: "runtime_request", requestId: "request-2", status: "pending", requestType: "input" })]);
    expect(event("runtime_request.resolved", {
      requestId: "request-2",
      action: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: { environment: { selectedOptionIds: ["staging"] } },
      },
    })).toEqual([expect.objectContaining({
      kind: "runtime_request",
      requestId: "request-2",
      status: "resolved",
      prompt: "Choose",
      requestType: "input",
      resolvedAction: "submit",
      response: {
        schema: "paperclip.question_response.v1",
        answers: { environment: { selectedOptionIds: ["staging"] } },
      },
    })]);
    expect(event("runtime_request.created", { request: { requestId: "request-redacted", requestKind: "runtime", type: "input", status: "pending", prompt: "Choose", input: { schema: "***REDACTED***", questions: [{ id: "environment", prompt: "Where?", required: true, answerMode: "single_select", options: [{ id: "staging", label: "Staging" }] }] } } }))
      .toEqual([expect.objectContaining({ kind: "runtime_request", requestId: "request-redacted", questionSet: expect.objectContaining({ schema: "paperclip.question_set.v1" }) })]);
    expect(event("runtime_request.expired", { requestId: "request-redacted", reason: "provider_process_lost" }))
      .toEqual([expect.objectContaining({ kind: "runtime_request", requestId: "request-redacted", status: "expired", prompt: "Choose", requestType: "input" })]);
    expect(event("runtime_request.created", { request: { requestId: "request-cancel", requestKind: "runtime", type: "input", status: "pending", prompt: "Cancel me", input: { schema: "paperclip.question_set.v1", questions: [{ id: "reason", prompt: "Why?", required: false, answerMode: "text" }] } } }))
      .toEqual([expect.objectContaining({ requestId: "request-cancel", status: "pending" })]);
    expect(event("runtime_request.resolved", { requestId: "request-cancel", action: "cancel" }))
      .toEqual([expect.objectContaining({ requestId: "request-cancel", status: "cancelled", resolvedAction: "cancel" })]);
    expect(event("run.terminal", { turnTerminalState: "interrupted", runTerminalState: "cancelled", reportedWorkDisposition: "yielded", stopReason: { code: "user_stop" } }))
      .toEqual([expect.objectContaining({ kind: "run_terminal", turnState: "interrupted", runState: "cancelled", disposition: "yielded", stopReason: "user_stop" })]);
  });

  it("normalizes MCP semantic tools, canonical usage, and actionable failures", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("mcp_app.tool_input", {
      semantic_tool: { callId: "mcp-1", operationId: "paperclip.tasks.create", content: { references: [{ kind: "issue", id: "PAP-2" }] } },
    })).toEqual([expect.objectContaining({ kind: "tool_call", toolUseId: "mcp-1", name: "paperclip.tasks.create" })]);
    expect(event("mcp_app.tool_result", {
      semantic_tool: { callId: "mcp-1", operationId: "paperclip.tasks.create", outcome: "denied", code: "audience_denied" },
    })).toEqual([expect.objectContaining({ kind: "tool_result", toolUseId: "mcp-1", isError: true })]);
    expect(event("usage.reported", {
      runDelta: { inputTokens: 240, outputTokens: 60, cacheReadTokens: 120 },
    })).toEqual([expect.objectContaining({ kind: "result", inputTokens: 240, outputTokens: 60, cachedTokens: 120 })]);
    expect(event("mcp_app.failed", { code: "host_unavailable", message: "Artifact host unavailable" }))
      .toEqual([expect.objectContaining({ kind: "system", text: "Runner: Artifact host unavailable" })]);
  });
});
