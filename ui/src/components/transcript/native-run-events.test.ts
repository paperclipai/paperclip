import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HeartbeatRunEvent } from "@paperclipai/shared";
import { nativeRunEventsToTranscript } from "./native-run-events";
import { paperclipRunnerFinalResponse, settledRunChildren, transcriptToTaskChatItems } from "../task-chat/transcript-adapter";

const RUN_ID = "10000000-0000-4000-8000-000000000001";

function event(
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
  overrides: Partial<HeartbeatRunEvent> = {},
): HeartbeatRunEvent {
  return {
    id: seq,
    companyId: "10000000-0000-4000-8000-000000000002",
    runId: RUN_ID,
    agentId: "10000000-0000-4000-8000-000000000003",
    seq,
    eventType,
    stream: "system",
    level: "info",
    color: null,
    message: null,
    payload: {
      prpEvent: {
        schema: "paperclip.prp.event.v1",
        sourceEventId: `event-${seq}`,
        sourceSeq: seq,
        sourceInstanceId: "runner-1",
        sourceKind: "runner",
        runId: RUN_ID,
        normalizedSessionId: "session-1",
        eventType,
        schemaVersion: 1,
        priority: 1,
        emittedAt: `2026-08-25T18:00:${String(seq).padStart(2, "0")}.000Z`,
        payload,
      },
    },
    createdAt: new Date("2026-08-25T18:00:00.000Z"),
    ...overrides,
  };
}

function itemEvent(
  seq: number,
  eventType: "item.started" | "item.delta" | "item.completed",
  itemId: string,
  payload: Record<string, unknown>,
): HeartbeatRunEvent {
  const value = event(seq, eventType, payload);
  (value.payload!.prpEvent as Record<string, unknown>).itemId = itemId;
  return value;
}

function runResult(summary: string): Record<string, unknown> {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "done",
    summary,
    completionClaim: {
      contractRevision: "test-v1",
      objectiveSatisfied: true,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [],
    attentionRequests: [],
    artifacts: [],
  };
}

describe("provider notice presentation", () => {
  it("omits unrelated information from saved chat without removing warnings or responses", () => {
    const legacyNotice = {
      schema: "paperclip.provider.notice.v1",
      noticeId: "codex-warning",
      severity: "warning",
      category: "warning",
      summary: "ignored unrelated provider information",
      userActionable: true,
    };
    const entries = nativeRunEventsToTranscript([
      event(1, "provider.notice.recorded", legacyNotice),
      event(2, "harness.diagnostic", { code: "codex_unrelated_information" }),
      event(3, "provider.notice.recorded", { ...legacyNotice, summary: "Repository is not trusted" }),
      event(4, "provider.notice.recorded", { ...legacyNotice, severity: "error" }),
      event(5, "provider.notice.recorded", { ...legacyNotice, category: "configWarning" }),
      event(6, "item.completed", { kind: "agentMessage", channel: "final", text: "Here is the answer." }),
    ]);
    expect(entries).toMatchObject([
      { kind: "provider_activity", summary: "Repository is not trusted" },
      { kind: "provider_activity", status: "failed", summary: legacyNotice.summary },
      { kind: "provider_activity", summary: legacyNotice.summary },
      { kind: "assistant", text: "Here is the answer." },
    ]);
  });

  it("preserves notice text as a notice rather than a synthetic tool call", () => {
    const entries = nativeRunEventsToTranscript([
      event(1, "provider.notice.recorded", {
        schema: "paperclip.provider.notice.v1", noticeId: "warning-1",
        severity: "warning", category: "configWarning", summary: "Repository is not trusted",
      }),
      event(2, "provider.notice.recorded", {
        schema: "paperclip.provider.notice.v1", noticeId: "error-1",
        severity: "error", message: "Provider connection failed",
      }),
    ]);
    expect(entries).toMatchObject([
      { kind: "provider_activity", family: "provider_notice", status: "informational", summary: "Repository is not trusted" },
      { kind: "provider_activity", family: "provider_notice", status: "failed", summary: "Provider connection failed" },
    ]);
    expect(entries.some((entry) => entry.kind === "tool_call")).toBe(false);
  });
});

describe("native plan presentation", () => {
  it("keeps plan snapshots as plan activity so the turn plan card can read their steps", () => {
    const plan = (seq: number, statuses: string[]) => event(seq, "plan.updated", {
      schema: "paperclip.plan.updated.v1",
      planId: "turn-1",
      revision: 1,
      explanation: null,
      steps: statuses.map((status, index) => ({ stepId: `step-${index + 1}`, body: `Step ${index + 1}`, status })),
      complete: statuses.every((status) => status === "completed"),
      syncStatus: "not_applicable",
      documentRevision: null,
    });
    const transcript = nativeRunEventsToTranscript([
      plan(1, ["in_progress", "pending"]),
      plan(2, ["completed", "completed"]),
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({ kind: "provider_activity", family: "plan", status: "running", title: "Plan" }),
      expect.objectContaining({ kind: "provider_activity", family: "plan", status: "completed" }),
    ]);
    const items = transcriptToTaskChatItems(transcript, { runId: RUN_ID, agentName: "Claude", running: true });
    const plans = items.filter((item) => item.kind === "protocol" && item.surface === "provider_activity" && item.family === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ steps: [
      { label: "Step 1", status: "completed" },
      { label: "Step 2", status: "completed" },
    ] });
  });

  it("keeps a blocked plan blocked in settled history instead of marking it interrupted", () => {
    const transcript = nativeRunEventsToTranscript([event(1, "plan.updated", {
      schema: "paperclip.plan.updated.v1",
      planId: "turn-1",
      revision: 1,
      explanation: null,
      steps: [
        { stepId: "step-1", body: "Inspect", status: "completed" },
        { stepId: "step-2", body: "Run tests", status: "blocked" },
      ],
      complete: false,
      syncStatus: "not_applicable",
      documentRevision: null,
    })]);
    expect(transcript[0]).toMatchObject({ kind: "provider_activity", family: "plan", status: "failed" });
    const settled = transcriptToTaskChatItems(transcript, { runId: RUN_ID, agentName: "Claude", running: false });
    const plan = settled.find((item) => item.kind === "protocol" && item.surface === "provider_activity" && item.family === "plan");
    expect(plan).toMatchObject({ status: "failed" });
    expect(JSON.stringify(plan)).not.toContain("Interrupted before completion");
  });
});

describe("native proposed-plan presentation", () => {
  it("streams Codex plan-item deltas into one live proposal and settles on the completed document", () => {
    const transcript = nativeRunEventsToTranscript([
      itemEvent(1, "item.started", "plan-item-1", { kind: "plan", channel: "detail", text: "" }),
      itemEvent(2, "item.delta", "plan-item-1", { kind: "plan", channel: "detail", text: "<proposed_plan>\n# Stop duplicates\n" }),
      itemEvent(3, "item.delta", "plan-item-1", { kind: "plan", channel: "detail", text: "\n1. Add a unique index" }),
      event(4, "plan.proposed", {
        schema: "paperclip.plan.proposed.v1",
        proposalId: "plan-item-1",
        status: "completed",
        markdown: "# Stop duplicates\n\n1. Add a unique index\n2. Upsert",
        source: "codex_plan_item",
      }),
    ]);
    const proposals = transcript.filter((entry) => entry.kind === "provider_activity" && entry.family === "plan_proposal");
    expect(proposals).toEqual([
      expect.objectContaining({ status: "running", payload: expect.objectContaining({ markdown: "# Stop duplicates" }) }),
      expect.objectContaining({ status: "running", payload: expect.objectContaining({ markdown: "# Stop duplicates\n\n1. Add a unique index" }) }),
      expect.objectContaining({ status: "completed", summary: "Proposed a plan" }),
    ]);

    const live = transcriptToTaskChatItems(transcript.slice(0, -1), { runId: RUN_ID, agentName: "Codex", running: true })
      .filter((item) => item.kind === "protocol" && item.surface === "provider_activity" && item.family === "plan_proposal");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "running", output: "# Stop duplicates\n\n1. Add a unique index" });

    const settled = transcriptToTaskChatItems(transcript, { runId: RUN_ID, agentName: "Codex", running: false })
      .filter((item) => item.kind === "protocol" && item.surface === "provider_activity" && item.family === "plan_proposal");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ status: "completed", output: "# Stop duplicates\n\n1. Add a unique index\n2. Upsert" });
  });

  it("shows a Codex message's <proposed_plan> block only through the proposal card", () => {
    const transcript = nativeRunEventsToTranscript([
      itemEvent(1, "item.completed", "msg-1", {
        kind: "agentMessage",
        channel: "final",
        text: "The plan is ready for your approval.\n<proposed_plan>\n# Fix\n1. Ship\n</proposed_plan>",
      }),
      event(2, "plan.proposed", {
        schema: "paperclip.plan.proposed.v1",
        proposalId: "msg-1",
        status: "completed",
        markdown: "# Fix\n1. Ship",
        source: "codex_plan_item",
      }),
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({ kind: "assistant", text: "The plan is ready for your approval." }),
      expect.objectContaining({ kind: "provider_activity", family: "plan_proposal", status: "completed" }),
    ]);
  });

  it("keeps a message's plan text when no proposal was recorded for it", () => {
    const text = "Draft plan below.\n<proposed_plan>\n# Fix\n1. Ship\n</proposed_plan>";
    const transcript = nativeRunEventsToTranscript([
      itemEvent(1, "item.completed", "msg-old", { kind: "agentMessage", channel: "final", text }),
    ]);
    expect(transcript).toEqual([expect.objectContaining({ kind: "assistant", text })]);
  });

  it("hides the cut-off remainder of a proposal in a shortened message preview", () => {
    const transcript = nativeRunEventsToTranscript([
      itemEvent(1, "item.completed", "msg-1", {
        kind: "agentMessage",
        channel: "final",
        text: "Plan ready.\n<proposed_plan>\n# Fix\n1. Ship…[truncated]",
      }),
      event(2, "plan.proposed", {
        schema: "paperclip.plan.proposed.v1", proposalId: "msg-1", status: "completed",
        markdown: "# Fix\n1. Ship\n2. Verify", source: "codex_plan_item",
      }),
    ]);
    expect(transcript[0]).toMatchObject({ kind: "assistant", text: "Plan ready." });

    const fenced = "Format:\n```\n<proposed_plan>\n# Plan…[truncated]";
    const fencedTranscript = nativeRunEventsToTranscript([
      itemEvent(1, "item.completed", "msg-2", { kind: "agentMessage", channel: "final", text: fenced }),
      event(2, "plan.proposed", {
        schema: "paperclip.plan.proposed.v1", proposalId: "msg-2", status: "completed",
        markdown: "# Other", source: "codex_plan_item",
      }),
    ]);
    expect(fencedTranscript[0]).toMatchObject({ kind: "assistant", text: fenced });
  });

  it("shows a completed proposal's example tags unchanged on its card", () => {
    const markdown = "# Plan\n\n1. Format: `<proposed_plan>x</proposed_plan>`";
    const transcript = nativeRunEventsToTranscript([event(1, "plan.proposed", {
      schema: "paperclip.plan.proposed.v1", proposalId: "p-1", status: "completed", markdown, source: "claude_exit_plan_mode",
    })]);
    expect(transcript[0]).toMatchObject({ family: "plan_proposal", payload: expect.objectContaining({ markdown }) });
  });

  it("keeps a Claude ExitPlanMode proposal out of the turn checklist", () => {
    const transcript = nativeRunEventsToTranscript([event(1, "plan.proposed", {
      schema: "paperclip.plan.proposed.v1",
      proposalId: "toolu_plan",
      status: "completed",
      markdown: "# Plan\n\n1. Ship it",
      source: "claude_exit_plan_mode",
    })]);
    expect(transcript).toEqual([
      expect.objectContaining({ kind: "provider_activity", family: "plan_proposal", status: "completed" }),
    ]);
    const items = transcriptToTaskChatItems(transcript, { runId: RUN_ID, agentName: "Claude", running: false });
    expect(items.some((item) => item.kind === "protocol" && item.surface === "provider_activity" && item.family === "plan")).toBe(false);
  });
});

describe("nativeRunEventsToTranscript", () => {
  describe("accepted response-wake authority", () => {
    function fixture() {
      const result = {
        ...runResult("The complete answer; the task remains open."),
        reportedWorkDisposition: "yielded",
        continuation: {
          kind: "response_wake",
          summary: "Wait for the next exact input.",
          idempotencyKey: "next-input",
        },
      };
      const accepted = event(2, "run.result.accepted", { result });
      const terminal = event(3, "run.terminal", {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "yielded",
      });
      const acceptedEnvelope = accepted.payload!.prpEvent as Record<
        string,
        unknown
      >;
      const terminalEnvelope = terminal.payload!.prpEvent as Record<
        string,
        unknown
      >;
      for (const envelope of [acceptedEnvelope, terminalEnvelope]) {
        envelope.sourceKind = "control_plane";
        envelope.sourceInstanceId = "control-1";
        envelope.turnId = "turn-1";
      }
      return { result, accepted, terminal, acceptedEnvelope, terminalEnvelope };
    }

    it("derives a closed marker only from a same-run accepted result and terminal", () => {
      const { accepted, terminal } = fixture();
      const entries = nativeRunEventsToTranscript([
        accepted,
        terminal,
        structuredClone(accepted),
      ]);
      expect(
        entries.find((entry) => entry.kind === "run_result"),
      ).toMatchObject({
        summary: "The complete answer; the task remains open.",
        acceptedResponseWake: { runId: RUN_ID, sourceEventId: "event-2" },
      });
      expect(
        entries.filter((entry) => entry.kind === "run_result"),
      ).toHaveLength(1);
    });

    it.each([
      "provider_acceptance",
      "provider_terminal",
      "proposal",
      "forged_marker",
      "missing_attention",
      "attention",
      "other_continuation",
      "blank_key",
      "blank_summary",
      "missing_source",
      "wrong_run",
      "wrong_event_type",
      "wrong_schema",
      "terminal_other_run",
      "terminal_other_owner",
      "terminal_other_session",
      "terminal_other_turn",
      "terminal_earlier",
      "terminal_failed",
      "terminal_interrupted",
      "terminal_other_disposition",
      "missing_terminal",
      "conflicting_acceptance",
      "pending_question",
      "pending_approval",
    ])("does not derive response-wake authority from %s", (mode) => {
      const { result, accepted, terminal, acceptedEnvelope, terminalEnvelope } =
        fixture();
      const mutableResult = result as Record<string, unknown>;
      const terminalPayload = terminalEnvelope.payload as Record<
        string,
        unknown
      >;
      const events = [accepted, terminal];
      if (mode === "provider_acceptance")
        acceptedEnvelope.sourceKind = "runner";
      if (mode === "provider_terminal") terminalEnvelope.sourceKind = "runner";
        if (mode === "proposal") {
          accepted.eventType = "run.result.proposed";
          acceptedEnvelope.eventType = accepted.eventType;
          acceptedEnvelope.payload = result;
        }
        if (mode === "forged_marker") {
          result.continuation.kind = "monitor";
          mutableResult.acceptedResponseWake = {
          runId: RUN_ID,
          sourceEventId: "event-2",
        };
      }
      if (mode === "missing_attention") delete mutableResult.attentionRequests;
      if (mode === "attention")
        mutableResult.attentionRequests = [{ kind: "ask_user_questions" }];
      if (mode === "other_continuation")
        result.continuation.kind = "same_agent";
      if (mode === "blank_key") result.continuation.idempotencyKey = " ";
      if (mode === "blank_summary") mutableResult.summary = " ";
      if (mode === "missing_source") acceptedEnvelope.sourceEventId = " ";
      if (mode === "wrong_run") acceptedEnvelope.runId = "other-run";
      if (mode === "wrong_event_type")
        acceptedEnvelope.eventType = "item.completed";
      if (mode === "wrong_schema") acceptedEnvelope.schema = "provider.result";
      if (mode === "terminal_other_run")
        terminal.runId = terminalEnvelope.runId = "other-run";
      if (mode === "terminal_other_owner")
        terminalEnvelope.sourceInstanceId = "other-owner";
      if (mode === "terminal_other_session")
        terminalEnvelope.normalizedSessionId = "other-session";
      if (mode === "terminal_other_turn")
        terminalEnvelope.turnId = "other-turn";
      if (mode === "terminal_earlier") terminal.seq = 1;
      if (mode === "terminal_failed")
        terminalPayload.runTerminalState = "failed";
      if (mode === "terminal_interrupted")
        terminalPayload.turnTerminalState = "interrupted";
      if (mode === "terminal_other_disposition")
        terminalPayload.reportedWorkDisposition = "done";
      if (mode === "missing_terminal") events.pop();
      if (mode === "conflicting_acceptance") {
        const other = structuredClone(accepted);
        other.seq = 4;
        (other.payload!.prpEvent as Record<string, unknown>).sourceEventId =
          "other-accepted-result";
        events.push(other);
      }
      if (mode === "pending_question" || mode === "pending_approval")
        events.push(
          event(4, "runtime_request.created", {
            requestId: "pending-request",
            requestKind:
              mode === "pending_question" ? "user_input" : "command_approval",
            status: "pending",
          }),
        );
      expect(
        nativeRunEventsToTranscript(events).find(
          (entry) => entry.kind === "run_result",
        )?.acceptedResponseWake,
      ).toBeUndefined();
    });
  });

  it("projects the cross-language duplicate-delivery fixture exactly once", () => {
    const fixture = JSON.parse(readFileSync(
      new URL(
        "../../../../packages/paperclip-runner/protocol/fixtures/replay/duplicate-event.json",
        import.meta.url,
      ),
      "utf8",
    )) as { events: Array<Record<string, unknown>> };
    const persistedEvents = fixture.events.map((prpEvent, index) => ({
      id: index + 1,
      companyId: "company_replay",
      runId: String(prpEvent.runId),
      agentId: "agent_replay",
      seq: index + 1,
      eventType: String(prpEvent.eventType),
      stream: "system" as const,
      level: "info" as const,
      color: null,
      message: null,
      payload: { prpEvent: structuredClone(prpEvent) },
      createdAt: new Date(String(prpEvent.emittedAt)),
    })) satisfies HeartbeatRunEvent[];

    const transcript = nativeRunEventsToTranscript(persistedEvents);
    expect(transcript.filter((entry) => entry.kind === "assistant")).toEqual([
      expect.objectContaining({
        text: "Exactly one projection.",
        channel: "final",
        itemId: "item_replay_duplicate",
      }),
    ]);
    expect(transcript.filter((entry) => entry.kind === "run_result")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.kind === "run_terminal")).toHaveLength(1);
  });

  it("preserves buffered output tails when a native turn ends", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "item.delta", { itemId: "reasoning-1", kind: "reasoning", text: "Thinking" }),
      event(2, "turn.completed", { status: "completed", outputTails: [
        { itemId: "reasoning-1", payload: { kind: "reasoning", text: "-" } },
      ] }),
    ]);
    expect(transcript.filter(entry => entry.kind === "thinking").map(entry => "text" in entry ? entry.text : "").join("")).toBe("Thinking-");
  });

  it("projects provider-neutral messages, tools, usage, and the final reply", () => {
    const transcript = nativeRunEventsToTranscript([
      event(6, "run.result.proposed", runResult("Done safely.")),
      event(1, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "Done " }),
      event(2, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "safely." }),
      event(3, "item.completed", { itemId: "message-1", kind: "agentMessage", text: "Done safely." }),
      event(4, "tool.execution.started", {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        name: "pnpm test",
        status: "running",
        output: null,
        outputBytes: 0,
        outputTruncated: false,
        outputDigest: null,
      }),
      event(5, "tool.execution.completed", {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        name: "pnpm test",
        status: "completed",
        output: "all green",
        outputBytes: 9,
        outputTruncated: false,
        outputDigest: null,
      }),
      event(7, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 2,
          providerCostUsd: 0.01,
        },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Done safely." }),
      expect.objectContaining({
        kind: "tool_call",
        name: "Bash",
        toolUseId: "exec-1",
        input: { command: "pnpm test" },
      }),
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "exec-1",
        content: "all green",
        isError: false,
      }),
      expect.objectContaining({
        kind: "run_result",
        summary: "Done safely.",
      }),
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_usage",
        inputTokens: 12,
        outputTokens: 3,
        cachedTokens: 2,
        costUsd: 0.01,
      }),
    ]);
  });

  it("coalesces sparse Codex tool lifecycle events at the named write boundary", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "tool.execution.started", {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-write-plan",
        transport: "dynamic",
        operation: "unknown",
        name: null,
        status: "running",
        output: null,
      }),
      itemEvent(2, "item.started", "exec-write-plan", {
        kind: "dynamicToolCall",
        item: { id: "exec-write-plan" },
      }),
      itemEvent(3, "item.started", "exec-write-plan", {
        kind: "dynamicToolCall",
        item: {
          type: "tool_use",
          id: "exec-write-plan",
          name: "write_document",
          input: {
            key: "plan",
            title: "Plan",
            body: "Ship the durable runner.",
          },
        },
      }),
      itemEvent(4, "item.completed", "exec-write-plan", {
        kind: "dynamicToolCall",
        item: {
          type: "tool_result",
          id: "exec-write-plan",
          tool_use_id: "exec-write-plan",
          result: {
            commandKind: "write_document",
            revisionId: "revision-1",
          },
        },
      }),
      event(5, "tool.execution.completed", {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-write-plan",
        transport: "dynamic",
        operation: "unknown",
        name: null,
        status: "completed",
        output: null,
      }),
      itemEvent(6, "item.completed", "exec-write-plan", {
        kind: "dynamicToolCall",
        item: { id: "exec-write-plan", status: "completed" },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        name: "write_document",
        toolUseId: "exec-write-plan",
        input: {
          key: "plan",
          title: "Plan",
          body: "Ship the durable runner.",
        },
      }),
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "exec-write-plan",
        toolName: "write_document",
        content: JSON.stringify({
          commandKind: "write_document",
          revisionId: "revision-1",
        }),
        isError: false,
      }),
    ]);
  });

  it("projects ACPX item-only tool lifecycles at the named write boundary", () => {
    const transcript = nativeRunEventsToTranscript([
      itemEvent(1, "item.started", "2", {
        kind: "dynamicToolCall",
        item: {
          type: "tool_use",
          id: "2",
          name: "write_document",
          input: {
            key: "plan",
            title: "Plan",
            body: "Ship the durable runner.",
          },
        },
      }),
      itemEvent(2, "item.completed", "2", {
        kind: "dynamicToolCall",
        item: {
          type: "tool_result",
          id: "2",
          tool_use_id: "2",
          result: {
            disposition: "applied",
            document: {
              key: "plan",
              latestRevisionId: "revision-1",
            },
          },
        },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "tool_call",
        name: "write_document",
        toolUseId: "2",
        input: {
          key: "plan",
          title: "Plan",
          body: "Ship the durable runner.",
        },
      }),
      expect.objectContaining({
        kind: "tool_result",
        toolUseId: "2",
        toolName: "write_document",
        content: JSON.stringify({
          disposition: "applied",
          document: {
            key: "plan",
            latestRevisionId: "revision-1",
          },
        }),
        isError: false,
      }),
    ]);
  });

  it("keeps retained stopped output as progress without fabricating a final response", () => {
    const fixture = JSON.parse(readFileSync(
      new URL("./fixtures/stopped-native-progress.json", import.meta.url),
      "utf8",
    )) as { run: { id: string; status: string }; events: HeartbeatRunEvent[] };
    const entries = nativeRunEventsToTranscript(fixture.events);
    const parsed = transcriptToTaskChatItems(entries, { runId: fixture.run.id, running: false });

    expect(fixture.run.status).toBe("cancelled");
    expect(paperclipRunnerFinalResponse(parsed, { allowFallback: true })).toBeUndefined();
    expect(parsed.filter((item) => item.kind === "message")).toEqual([
      expect.objectContaining({
        channel: "progress",
        interstitial: true,
        text: "I'll use the native Write tool once for the exact path, leaving the permission request pending.",
      }),
    ]);
    const children = settledRunChildren(parsed);
    expect(children.filter((item) => item.kind === "activity_phase" && item.interstitial)).toHaveLength(1);
    expect(children.filter((item) => item.kind === "protocol" && item.surface === "runtime_request")).toEqual([
      expect.objectContaining({ status: "cancelled" }),
    ]);
  });

  it.each([
    ["final", "progress", "final"],
    ["progress", "final", "progress"],
    ["unknown", "final", "unknown"],
    ["unknown", "invalid", "unknown"],
    ["unknown", null, "unknown"],
    [undefined, "progress", "progress"],
  ] as const)("preserves outer channel %s with nested channel %s", (outer, nested, expected) => {
    expect(nativeRunEventsToTranscript([
      itemEvent(1, "item.delta", "message-1", {
        kind: "agentMessage",
        ...(outer === undefined ? {} : { channel: outer }),
        text: "Provider message.",
        update: { channel: nested },
      }),
    ])).toEqual([
      expect.objectContaining({ kind: "assistant", channel: expected }),
    ]);
  });

  it("streams deltas until a loss-resistant completed item is available", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "Still " }),
      event(2, "item.delta", { itemId: "message-1", kind: "agentMessage", text: "working" }),
    ])).toEqual([
      expect.objectContaining({ kind: "assistant", text: "Still ", delta: true }),
      expect.objectContaining({ kind: "assistant", text: "working", delta: true }),
    ]);
  });

  it("streams canonical kind-less deltas using item identity from item.started", () => {
    expect(nativeRunEventsToTranscript([
      itemEvent(1, "item.started", "message-1", {
        kind: "assistant_message",
        channel: "progress",
        text: "",
      }),
      itemEvent(2, "item.delta", "message-1", { text: "Still " }),
      itemEvent(3, "item.delta", "message-1", { text: "working" }),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Still ",
        delta: true,
        channel: "progress",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "working",
        delta: true,
        channel: "progress",
      }),
    ]);
  });

  it("keeps a canonical assistant reply ahead of its semantic result card", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "item.completed", {
        kind: "assistant_message",
        text: "Canonical persisted reply.",
      }),
      event(2, "run.result.proposed", runResult(
        "Structured fallback must not replace the reply.",
      )),
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Canonical persisted reply.",
        channel: "unknown",
      }),
      expect.objectContaining({
        kind: "run_result",
        summary: "Structured fallback must not replace the reply.",
      }),
    ]);
    expect(transcript.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
  });

  it("sums run deltas without leaking session-cumulative usage", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 2,
          providerCostUsd: 0.01,
        },
        cumulative: {
          inputTokens: 112,
          outputTokens: 53,
          cacheReadTokens: 22,
          providerCostUsd: 1.01,
        },
      }),
      event(2, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: {
          inputTokens: 4,
          outputTokens: 2,
          cacheReadTokens: 1,
          providerCostUsd: 0.005,
        },
        cumulative: {
          inputTokens: 116,
          outputTokens: 55,
          cacheReadTokens: 23,
          providerCostUsd: 1.015,
        },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_usage",
        inputTokens: 16,
        outputTokens: 5,
        cachedTokens: 3,
        costUsd: 0.015,
      }),
    ]);
  });

  it("sums delta-only usage reports into one run summary", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: { inputTokens: 2, outputTokens: 1, providerCostUsd: 0.01 },
      }),
      event(2, "usage.reported", {
        runDeltaAvailable: true,
        runDelta: { inputTokens: 3, outputTokens: 4, providerCostUsd: 0.02 },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        inputTokens: 5,
        outputTokens: 5,
        costUsd: 0.03,
      }),
    ]);
  });

  it("uses the latest explicitly session-scoped total when run deltas are unavailable", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDeltaAvailable: false,
        runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
        cumulative: { inputTokens: 12, outputTokens: 3, providerCostUsd: 0.01 },
      }),
      event(2, "usage.reported", {
        runDeltaAvailable: false,
        runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
        cumulative: { inputTokens: 20, outputTokens: 5, providerCostUsd: 0.02 },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_session_usage",
        inputTokens: 20,
        outputTokens: 5,
        costUsd: 0.02,
        text: expect.stringContaining("session-cumulative"),
      }),
    ]);
  });

  it("fails closed for legacy usage reports without run-delta provenance", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "usage.reported", {
        runDelta: { inputTokens: 12, outputTokens: 3, providerCostUsd: 0.01 },
        cumulative: { inputTokens: 112, outputTokens: 53, providerCostUsd: 1.01 },
      }),
      event(2, "usage.reported", {
        runDelta: { inputTokens: 116, outputTokens: 55, providerCostUsd: 1.015 },
      }),
    ]);

    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "result",
        subtype: "paperclip_runner_session_usage",
        inputTokens: 112,
        outputTokens: 53,
        costUsd: 1.01,
      }),
    ]);
  });

  it("retains a report without manufacturing a provider final message", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "run.result.proposed", runResult("Recovered final reply.")),
    ])).toEqual([
      expect.objectContaining({
        kind: "run_result",
        summary: "Recovered final reply.",
      }),
    ]);
  });

  it("prefers an explicit final item completed after the result proposal", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "run.result.proposed", runResult("Structured fallback.")),
      itemEvent(2, "item.completed", "message-final", {
        kind: "assistant_message",
        channel: "final",
        text: "The complete final reply.",
      }),
    ])).toEqual([
      expect.objectContaining({
        kind: "run_result",
        summary: "Structured fallback.",
      }),
      expect.objectContaining({
        kind: "assistant",
        text: "The complete final reply.",
        channel: "final",
      }),
    ]);
  });

  it("does not append a fallback after a channel-less final delta", () => {
    expect(nativeRunEventsToTranscript([
      itemEvent(1, "item.started", "message-final", {
        kind: "assistant_message",
        text: "",
      }),
      itemEvent(2, "item.delta", "message-final", {
        text: "Streamed final reply.",
      }),
      event(3, "run.result.proposed", runResult("Structured fallback.")),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Streamed final reply.",
        delta: true,
        channel: "unknown",
      }),
      expect.objectContaining({
        kind: "run_result",
        summary: "Structured fallback.",
      }),
    ]);
  });

  it("keeps progress separate from the final runner response", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "item.completed", {
        itemId: "progress-1",
        kind: "agentMessage",
        channel: "progress",
        text: "Checking the implementation.",
      }),
      event(2, "run.result.accepted", {
        result: runResult("The implementation is ready."),
      }),
    ])).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Checking the implementation.",
        channel: "progress",
      }),
      expect.objectContaining({
        kind: "run_result",
        summary: "The implementation is ready.",
      }),
    ]);
  });

  it("keeps web research as a provider activity with its sources", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "research.started", {
        schema: "paperclip.research.v1",
        researchId: "research-1",
        action: "search",
        query: "current behavior",
        status: "running",
        sources: [],
      }),
      event(2, "research.completed", {
        schema: "paperclip.research.v1",
        researchId: "research-1",
        action: "search",
        query: "current behavior",
        status: "completed",
        sources: [{ sourceId: "s1", url: "https://example.com/a", title: "A", snippet: null }],
      }),
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({ kind: "provider_activity", family: "research", status: "running", summary: "current behavior" }),
      expect.objectContaining({
        kind: "provider_activity",
        family: "research",
        status: "completed",
        payload: expect.objectContaining({ sources: [expect.objectContaining({ url: "https://example.com/a" })] }),
      }),
    ]);
    expect(transcript.some((entry) => entry.kind === "tool_call" || entry.kind === "tool_result")).toBe(false);
    const items = transcriptToTaskChatItems(transcript, { runId: RUN_ID, running: false });
    const research = items.filter((item) => item.kind === "protocol" && item.surface === "provider_activity");
    expect(research).toHaveLength(1);
    expect(research[0]).toEqual(expect.objectContaining({
      status: "completed",
      links: [expect.objectContaining({ href: "https://example.com/a" })],
      startedAt: "2026-08-25T18:00:01.000Z",
    }));
  });

  it("does not invent a subject for a search the provider reported without a query", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "research.completed", {
        schema: "paperclip.research.v1",
        researchId: "research-2",
        action: "other",
        query: null,
        url: null,
        pattern: null,
        status: "completed",
        sources: [],
      }),
    ])).toEqual([expect.objectContaining({ kind: "provider_activity", family: "research", summary: "" })]);
  });

  it("keeps model reroutes and waits as provider activity with their payload", () => {
    const transcript = nativeRunEventsToTranscript([
      event(1, "model.route.changed", {
        schema: "paperclip.model.route_changed.v1",
        routeId: "turn-1",
        provider: "openai",
        requestedModel: "gpt-a",
        fromModel: "gpt-a",
        effectiveModel: "gpt-b",
        reason: "capacity",
      }),
      event(2, "wait.started", {
        schema: "paperclip.wait.v1",
        waitId: "sleep-1",
        reason: "timer",
        status: "running",
        plannedDurationMs: 30000,
        elapsedDurationMs: null,
      }),
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({ kind: "provider_activity", family: "model_identity", status: "completed", payload: expect.objectContaining({ effectiveModel: "gpt-b" }) }),
      expect.objectContaining({ kind: "provider_activity", family: "wait", status: "running", payload: expect.objectContaining({ plannedDurationMs: 30000 }) }),
    ]);
  });

  it("projects the runner's verification items as check activity", () => {
    const transcript = nativeRunEventsToTranscript([
      itemEvent(1, "item.completed", "result:verification:1", {
        kind: "verification",
        text: "passed: node --test",
        verification: { commandOrCheck: "node --test", status: "passed", detail: "6 tests passed" },
      }),
      itemEvent(2, "item.completed", "result:verification:2", {
        kind: "verification",
        text: "failed: pnpm typecheck",
        verification: { commandOrCheck: "pnpm typecheck", status: "failed" },
      }),
      itemEvent(3, "item.completed", "result:verification:3", { kind: "verification", text: "malformed" }),
      itemEvent(4, "item.completed", "result:verification:4", {
        kind: "verification",
        text: "not_run: pnpm test:e2e",
        verification: { commandOrCheck: "pnpm test:e2e", status: "not_run", reasonCode: "policy_restricted", detail: "x".repeat(300) },
      }),
    ]);
    expect(transcript).toEqual([
      expect.objectContaining({
        kind: "provider_activity",
        family: "verification",
        status: "completed",
        summary: "node --test",
        payload: expect.objectContaining({ verificationId: "result:verification:1", status: "passed", detail: "6 tests passed" }),
      }),
      expect.objectContaining({ kind: "provider_activity", family: "verification", status: "failed", summary: "pnpm typecheck" }),
      expect.objectContaining({ family: "verification", status: "informational", payload: expect.objectContaining({ reasonCode: "policy_restricted" }) }),
    ]);
    const checks = transcriptToTaskChatItems(transcript, { runId: RUN_ID, running: false })
      .filter((item) => item.kind === "protocol" && item.surface === "provider_activity");
    expect(checks).toHaveLength(3);
    const skipped = checks[2];
    expect(skipped.kind === "protocol" && skipped.surface === "provider_activity" && skipped.details).toEqual(expect.arrayContaining([
      { label: "Reason Code", value: "policy_restricted", mono: true },
      { label: "Detail", value: "x".repeat(300), mono: false },
    ]));
  });

  it("leaves families owned by other surfaces on the generic activity path", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "memory.citation.referenced", {
        schema: "paperclip.memory.citation.v1",
        citationId: "citation-1",
        messageItemId: "message-1",
        label: "Decision log",
        available: false,
        reference: null,
      }),
    ])).toEqual([
      expect.objectContaining({ kind: "tool_call", toolUseId: "memory:citation-1" }),
      expect.objectContaining({ kind: "tool_result", toolUseId: "memory:citation-1" }),
    ]);
  });

  it.each(["running", "pending", "in_progress"])(
    "keeps an explicitly %s activity open even when its event suffix looks terminal",
    (status) => {
      expect(nativeRunEventsToTranscript([
        event(1, "artifact.generated", {
          schema: "paperclip.artifact.generated.v1",
          artifactId: "artifact-1",
          status,
          reference: "artifacts/preview.png",
        }),
      ])).toEqual([
        expect.objectContaining({
          kind: "provider_activity",
          family: "artifact",
          status: "running",
        }),
      ]);
    },
  );

  it("fails closed for unsupported versions, prefix lookalikes, and mismatched payload schemas", () => {
    const unsupportedVersion = event(1, "model.verification.updated", {
      schema: "paperclip.model.verification.v1",
      verificationId: "verification-1",
      status: "completed",
      summary: "must not render",
    });
    (unsupportedVersion.payload!.prpEvent as Record<string, unknown>).schemaVersion = 2;

    expect(nativeRunEventsToTranscript([
      unsupportedVersion,
      event(2, "model.provider_message.recorded", {
        schema: "paperclip.model.provider_message.v1",
        routeId: "route-1",
        message: "provider envelope must not render",
      }),
      event(3, "model.verification.updated", {
        schema: "paperclip.provider.native.v1",
        verificationId: "verification-2",
        status: "completed",
        summary: "wrong payload schema must not render",
      }),
    ])).toEqual([]);
  });

  it("fails closed for mismatched tool execution and run result schemas", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "tool.execution.started", {
        schema: "paperclip.provider.native.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        status: "running",
      }),
      event(2, "run.result.proposed", {
        schema: "paperclip.provider.native.v1",
        summary: "malformed proposal must not render",
      }),
      event(3, "run.result.accepted", {
        result: {
          schema: "paperclip.provider.native.v1",
          summary: "malformed accepted result must not render",
        },
      }),
      event(4, "run.result.accepted", {
        schema: "paperclip.run_result.v1",
        summary: "accepted wrappers must not masquerade as results",
      }),
    ])).toEqual([]);
  });

  it("fails closed for malformed, mismatched, and unknown event envelopes", () => {
    const mismatched = event(1, "item.delta", {
      itemId: "message-1",
      kind: "agentMessage",
      text: "must not render",
    });
    (mismatched.payload!.prpEvent as Record<string, unknown>).runId = "other-run";
    const malformed = event(2, "item.delta", {});
    malformed.payload = { providerNativeSecret: "must not render" };

    expect(nativeRunEventsToTranscript([
      mismatched,
      malformed,
      event(3, "extension.unknown", { explanation: "not a transcript row" }),
    ])).toEqual([]);
  });

  it("projects structured questions through resolution without losing identity", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "runtime_request.created", {
        request: {
          schema: "paperclip.runtime_request.v1",
          requestId: "question-1",
          requestKind: "elicitation",
          type: "input",
          status: "pending",
          prompt: "Choose a rollout",
          input: {
            schema: "paperclip.question_set.v1",
            questions: [{
              id: "rollout",
              prompt: "Which rollout?",
              required: true,
              answerMode: "single_select",
              options: [{ id: "safe", label: "Safe" }],
            }],
          },
        },
      }),
      event(2, "runtime_request.resolved", {
        request: {
          requestId: "question-1",
          status: "resolved",
          response: {
            schema: "paperclip.question_response.v1",
            answers: { rollout: { selectedOptionIds: ["safe"] } },
          },
        },
      }),
    ])).toEqual([
      expect.objectContaining({
        kind: "runtime_request",
        requestId: "question-1",
        status: "pending",
        questionSet: expect.objectContaining({ schema: "paperclip.question_set.v1" }),
      }),
      expect.objectContaining({
        kind: "runtime_request",
        requestId: "question-1",
        status: "resolved",
        response: expect.objectContaining({ schema: "paperclip.question_response.v1" }),
      }),
    ]);
  });

  it.each([
    ["failed", "failed", "failed"],
    ["interrupted", "cancelled", "cancelled"],
    ["cancelled", "cancelled", "cancelled"],
  ] as const)(
    "projects a visible %s terminal state",
    (turnTerminalState, runTerminalState, expectedRunState) => {
      expect(nativeRunEventsToTranscript([
        event(1, "run.terminal", {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState,
          runTerminalState,
          reportedWorkDisposition: "needs_review",
          stopReason: {
            schema: "paperclip.stop_reason.v1",
            code: "provider_failed",
            message: "Provider could not finish the turn.",
          },
        }),
      ])).toEqual([
        expect.objectContaining({
          kind: "run_terminal",
          turnState: turnTerminalState,
          runState: expectedRunState,
          stopReason: "Provider could not finish the turn.",
        }),
      ]);
    },
  );

  it("fails closed instead of presenting malformed terminal state as success", () => {
    expect(nativeRunEventsToTranscript([
      event(1, "run.terminal", {
        schema: "paperclip.prp.terminal.v1",
        turnTerminalState: "mystery",
        runTerminalState: "successful-ish",
        reportedWorkDisposition: "done",
      }),
    ])).toEqual([]);
  });
});

describe("tool execution facts", () => {
  const tool = (seq: number, eventType: string, fields: Record<string, unknown>) =>
    event(seq, eventType, {
      schema: "paperclip.tool.execution.v1",
      executionId: "toolu_bash",
      transport: "builtin",
      operation: "execute",
      name: "Bash",
      target: null,
      status: "running",
      durationMs: null,
      exitCode: null,
      output: null,
      outputBytes: 0,
      outputTruncated: false,
      outputDigest: null,
      ...fields,
    });

  it("carries the refined command, exit code, duration and refusal into the task-chat row", () => {
    const transcript = nativeRunEventsToTranscript([
      tool(1, "tool.execution.started", { name: "Terminal" }),
      tool(2, "tool.execution.progressed", { subject: "node --test", description: "Run the unit tests" }),
      tool(3, "tool.execution.completed", {
        subject: "node --test", description: "Run the unit tests", status: "failed", exitCode: 1, durationMs: 1840,
        output: "not ok 2", outputBytes: 8,
      }),
      event(4, "tool.execution.completed", {
        schema: "paperclip.tool.execution.v1", executionId: "toolu_rm", transport: "builtin", operation: "execute",
        name: "Bash", target: null, status: "failed", durationMs: 3, exitCode: null, subject: "rm -rf build",
        blockedReason: "Denied by rule", output: null, outputBytes: 0, outputTruncated: false, outputDigest: null,
      }),
      event(5, "tool.execution.completed", {
        schema: "paperclip.tool.execution.v1", executionId: "exec-read", transport: "process", operation: "read",
        name: "/bin/zsh -lc 'cat src/db.ts'", target: "src/db.ts", subject: "cat src/db.ts", status: "completed",
        durationMs: 19, exitCode: 0, output: "", outputBytes: 0, outputTruncated: false, outputDigest: null,
      }),
    ]);
    const tools = transcriptToTaskChatItems(transcript, { runId: RUN_ID, running: false }).filter((item) => item.kind === "tool");
    expect(tools).toEqual([
      expect.objectContaining({
        rawName: "Bash", target: "node --test", description: "Run the unit tests", status: "failed", exitCode: 1, durationMs: 1840,
      }),
      expect.objectContaining({ rawName: "Bash", target: "rm -rf build", blockedReason: "Denied by rule" }),
      expect.objectContaining({ rawName: "Read", operation: "read", target: "src/db.ts", exitCode: 0, durationMs: 19 }),
    ]);
  });
});

describe("edit diffs", () => {
  const execution = (status: string, fileChanges?: unknown[]) => ({
    schema: "paperclip.tool.execution.v1",
    executionId: "edit-1",
    transport: "builtin",
    operation: "edit",
    name: "Edit",
    target: null,
    status,
    output: "",
    outputBytes: 0,
    outputTruncated: false,
    outputDigest: null,
    ...(fileChanges ? { fileChanges } : {}),
  });
  const change = (diff: string, additions: number, deletions: number) => ({
    path: "src/price.js",
    operation: "modify",
    previousPath: null,
    additions,
    deletions,
    diff,
    diffTruncated: false,
  });

  it("attaches the latest patch of an edit call to its row", () => {
    const entries = nativeRunEventsToTranscript([
      event(1, "tool.execution.started", execution("running", [change("@@ -1 +1 @@\n-a\n+optimistic\n", 1, 1)])),
      event(2, "tool.execution.completed", execution("completed", [change("@@ -3,2 +3,2 @@\n ctx\n-a\n+b\n", 1, 1)])),
    ]);
    expect(entries.find((entry) => entry.kind === "tool_call")).toMatchObject({
      toolUseId: "edit-1",
      input: { path: "src/price.js" },
    });
    expect(entries.filter((entry) => entry.kind === "diff")).toEqual([
      expect.objectContaining({ changeType: "file_header", text: "src/price.js", toolUseId: "edit-1" }),
      expect.objectContaining({ changeType: "hunk", text: "@@ -3,2 +3,2 @@" }),
      expect.objectContaining({ changeType: "context", text: "ctx" }),
      expect.objectContaining({ changeType: "remove", text: "a" }),
      expect.objectContaining({ changeType: "add", text: "b" }),
    ]);

    const [tool] = transcriptToTaskChatItems(entries, { runId: RUN_ID, running: false });
    expect(tool).toMatchObject({ kind: "tool", target: "src/price.js", diff: { path: "src/price.js", added: 1, removed: 1 } });
  });

  it("attaches an edit's patch once when later events refine the call", () => {
    const entries = nativeRunEventsToTranscript([
      event(1, "tool.execution.started", execution("running", [change("@@ -1 +1 @@\n-a\n+b\n", 1, 1)])),
      event(2, "tool.execution.progressed", { ...execution("running"), subject: "edit price" }),
      event(3, "tool.execution.completed", { ...execution("completed", [change("@@ -1 +1 @@\n-a\n+b\n", 1, 1)]), durationMs: 40 }),
    ]);
    expect(entries.filter((entry) => entry.kind === "tool_call").length).toBeGreaterThan(1);
    expect(entries.filter((entry) => entry.kind === "diff" && entry.changeType === "file_header")).toHaveLength(1);
  });

  it("projects the harness change set and ends the turn with it", () => {
    const entries = nativeRunEventsToTranscript([
      event(1, "workspace.change.updated", {
        schema: "paperclip.workspace.diff.v1",
        changeSetId: "turn-1:workspace",
        revision: 1,
        source: "harness_reported",
        complete: false,
        files: [
          { path: "a.js", operation: "create", previousPath: null, additions: 2, deletions: 0, binary: false, diff: "@@ -0,0 +1,2 @@\n+x\n+y\n" },
          { path: "huge.js", operation: "modify", previousPath: null, additions: 0, deletions: 0, binary: false, diff: null, diffTruncated: true },
        ],
        totals: { files: 1, additions: 2, deletions: 0 },
        patchArtifactRef: null,
      }),
      event(2, "tool.execution.completed", execution("completed", [change("@@ -1 +1 @@\n-a\n+b\n", 1, 1)])),
    ]);
    const items = transcriptToTaskChatItems(entries, { runId: RUN_ID, running: false });
    expect(items.at(-1)).toMatchObject({ surface: "workspace_change", complete: true, totals: { files: 2, additions: 2 } });
    const card = items.at(-1);
    if (card?.kind !== "protocol" || card.surface !== "workspace_change") throw new Error("expected changes");
    expect(card.files[1]).toMatchObject({ path: "huge.js", diff: null, diffTruncated: true });
    expect(items.filter((item) => item.kind === "protocol" && item.surface === "workspace_change")).toHaveLength(1);
  });
});
