import { describe, expect, it } from "vitest";

import {
  capabilityAllowlistedInputFields,
  capabilityEvidenceDetail,
  capabilityEvidenceDetails,
  redactCapabilityEvidenceData,
  redactCapabilityToolResult,
} from "../live/evidence-redaction.js";
import { toCapabilityPublicThreadView } from "./public-view.js";
import { CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA, type CapabilityIssueThreadSnapshot } from "./types.js";

/**
 * Track 7U, finding 1, at the unit level.
 *
 * The end-to-end sweep in `clean-room-server.test.ts` proves nothing forbidden
 * reaches the wire. These tests pin the two components that make that true, so
 * a regression names the layer that broke rather than only the symptom.
 */

const CANARY = "CANARY-9f31c7ab";

/** Provider-shaped identifiers: opaque, long, and not ours to publish. */
const PROVIDER_TURN = "turn_01HZX8Q2M4KDR7VJ";
const PROVIDER_CALL = "call_01HZX8Q2M4KDR7VJ";
const PROVIDER_THREAD = "thr_01HZX8Q2M4KDR7VJWN";

function projectedView(): CapabilityIssueThreadSnapshot {
  return {
    schema: CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA,
    sessionId: "session-1",
    mode: "live",
    identity: {
      agentLabel: "Real Codex",
      runnerLabel: "Real runnerd",
      runnerAttached: true,
      controlPlaneLabel: "Mock Paperclip",
      controlPlaneTooltip: "All issue records are mock.",
      replaySource: null,
    },
    issue: {
      identifier: "MCK-31",
      title: "Mock task",
      status: "in_progress",
      priority: "high",
      assignee: "Mock Engineer",
      runState: "run-1 · idle",
      scenarioId: "clean-room",
      fixtureProfile: "clean-room",
    },
    turns: [
      {
        id: PROVIDER_TURN,
        ordinal: 1,
        mode: "live",
        toolCallCount: 1,
        at: "2026-08-10T00:00:00.000Z",
        stoppedByUser: false,
        items: [
          {
            kind: "tool_activity",
            id: `item-call-${PROVIDER_CALL}`,
            at: "2026-08-10T00:00:01.000Z",
            status: "ok",
            operationId: "report_progress",
            summary: "state revision 2",
            input: { fields: ["body"], leaked: CANARY } as never,
            result: { ok: true, stateRevision: 2, detail: CANARY } as never,
            evidenceRef: { section: "calls", recordId: PROVIDER_CALL },
          },
        ],
      },
    ],
    composer: { state: "ready", helper: null, reason: null, pendingInteractionId: null },
    evidence: {
      tools: [],
      calls: [
        {
          id: PROVIDER_CALL,
          turnId: PROVIDER_TURN,
          operationId: "report_progress",
          version: 1,
          providerRequest: "tools/call report_progress · 1 field",
          dispatchedCommand: "control_plane.dispatch(report_progress)",
          outcome: "ok",
          result: { ok: true, stateRevision: 2, detail: CANARY } as never,
          redactions: ["tool_result_detail"],
          threadAnchorId: `item-call-${PROVIDER_CALL}`,
        },
      ],
      authorization: [],
      control_plane: [],
      runner: [
        {
          id: "evidence-000001",
          turnId: PROVIDER_TURN,
          kind: "provider_event",
          ordinal: 1,
          detail: `provider event · assistant_delta (${PROVIDER_THREAD})`,
          details: [
            { label: "Event", value: "assistant_delta" },
            { label: "Provider", value: PROVIDER_THREAD },
          ],
        },
      ],
      state: [],
      traceability: [],
      parity: [],
    },
    connection: { state: "connected", attempt: 0 },
    replay: null,
    renderedAt: "2026-08-10T00:00:02.000Z",
  };
}

describe("Capability public issue-thread DTO", () => {
  it("copies by allowlist, so a field added to the projection cannot ship", () => {
    const view = projectedView() as CapabilityIssueThreadSnapshot & { leakedTop?: string };
    view.leakedTop = CANARY;
    (view.issue as unknown as Record<string, string>).leakedIssue = CANARY;
    (view.turns[0]!.items[0] as unknown as Record<string, string>).leakedItem = CANARY;

    const encoded = JSON.stringify(toCapabilityPublicThreadView(view));

    expect(encoded).not.toContain(CANARY);
    expect(encoded).not.toContain("leakedTop");
    expect(encoded).not.toContain("leakedIssue");
    expect(encoded).not.toContain("leakedItem");
  });

  it("narrows a tool payload to the summary the UI renders", () => {
    const published = toCapabilityPublicThreadView(projectedView());
    const item = published.turns[0]!.items[0]!;

    expect(item.kind).toBe("tool_activity");
    if (item.kind !== "tool_activity") throw new Error("expected a tool activity item");
    expect(item.input).toEqual({ fields: ["body"] });
    expect(item.result).toEqual({ ok: true, stateRevision: 2, result: { entityRefs: [] } });
    expect(JSON.stringify(published.evidence.calls[0]!.result)).not.toContain(CANARY);
  });

  it("replaces provider identifiers with in-view aliases everywhere they appear", () => {
    const published = toCapabilityPublicThreadView(projectedView());
    const encoded = JSON.stringify(published);

    expect(published.turns[0]!.id).toBe("turn-1");
    expect(published.evidence.calls[0]!.id).toBe("call-1");
    expect(published.evidence.calls[0]!.turnId).toBe("turn-1");
    expect(published.evidence.calls[0]!.threadAnchorId).toBe("item-call-call-1");
    expect(published.turns[0]!.items[0]!.id).toBe("item-call-call-1");
    // The anchor and the record it points at still agree, which is the whole
    // reason aliases are used instead of dropping the ids.
    expect(published.turns[0]!.items[0]!.kind === "tool_activity"
      ? published.turns[0]!.items[0]!.evidenceRef.recordId
      : null).toBe("call-1");
    expect(encoded).not.toContain(PROVIDER_TURN);
    expect(encoded).not.toContain(PROVIDER_CALL);
  });

  it("scrubs withheld provider identity even out of free-text detail", () => {
    const published = toCapabilityPublicThreadView(projectedView(), {
      withheldValues: [PROVIDER_THREAD, ""],
    });

    expect(JSON.stringify(published)).not.toContain(PROVIDER_THREAD);
    expect(published.evidence.runner[0]!.detail).toContain("[withheld]");
  });

  it("publishes semantic provider fields through a family allowlist and tails output", () => {
    const view = projectedView();
    view.turns[0]!.items.push({
      kind: "provider_activity",
      id: "provider-exec-1",
      at: "2026-08-10T00:00:01.500Z",
      family: "tool_execution",
      eventType: "tool.execution.completed",
      status: "completed",
      title: "Run",
      summary: "Tests passed",
      payload: {
        schema: "paperclip.tool.execution.v1",
        executionId: "exec-1",
        transport: "process",
        operation: "execute",
        status: "completed",
        output: `prefix-${"x".repeat(9_000)}`,
        outputBytes: 9_007,
        outputTruncated: true,
        outputDigest: "sha256:fixture",
        nativePayload: CANARY,
        stdin: "must-not-ship",
      },
      evidenceRef: { section: "runner", recordId: "evidence-000001" },
    });

    const published = toCapabilityPublicThreadView(view);
    const item = published.turns[0]!.items.find((entry) => entry.kind === "provider_activity");
    expect(item?.kind).toBe("provider_activity");
    if (item?.kind !== "provider_activity") throw new Error("expected provider activity");
    const payload = item.payload as Record<string, unknown>;
    expect(String(payload.output)).toHaveLength(8 * 1024);
    expect(payload.outputBytes).toBe(9_007);
    expect(JSON.stringify(payload)).not.toContain(CANARY);
    expect(payload).not.toHaveProperty("stdin");
    expect(payload).not.toHaveProperty("nativePayload");
  });
});

describe("Capability evidence redaction", () => {
  it("reduces a provider notification to a coarse category", () => {
    const redacted = redactCapabilityEvidenceData("provider_event", {
      method: "item/agentMessage/delta",
      params: {
        threadId: PROVIDER_THREAD,
        delta: CANARY,
        model: "codex-internal-preview",
        usage: { inputTokens: 4211 },
      },
    });

    expect(redacted).toEqual({ event: "assistant_delta" });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
    expect(capabilityEvidenceDetail("provider_event", redacted)).toBe("provider event · assistant_delta");
  });

  it("recognizes progress notifications without retaining their text", () => {
    for (const method of [
      "item/reasoning/summaryTextDelta",
      "item/plan/delta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
    ]) {
      const redacted = redactCapabilityEvidenceData("provider_event", {
        method,
        params: { delta: CANARY },
      });
      expect(String(redacted.event)).toMatch(/_delta$/);
      expect(JSON.stringify(redacted)).not.toContain(CANARY);
      expect(capabilityEvidenceDetails("provider_event", redacted)).toEqual([
        { label: "Event", value: redacted.event },
      ]);
    }
  });

  it("retains each known Codex tool lifecycle category without its payload", () => {
    for (const [type, expected] of [
      ["commandExecution", "command_started"],
      ["fileChange", "file_change_started"],
      ["mcpToolCall", "tool_started"],
      ["dynamicToolCall", "tool_started"],
    ] as const) {
      const redacted = redactCapabilityEvidenceData("provider_event", {
        method: "item/started",
        params: { item: { type, command: `echo ${CANARY}`, output: CANARY } },
      });
      expect(redacted).toEqual({ event: expected });
      expect(JSON.stringify(redacted)).not.toContain(CANARY);
    }
  });

  it("shows bounded structured shell commands while redacting credential values", () => {
    const redacted = redactCapabilityEvidenceData("provider_event", {
      method: "item/started",
      params: {
        item: {
          type: "commandExecution",
          source: "unifiedExecStartup",
          command: "/bin/bash -lc 'curl -H \"Authorization: Bearer hidden-token\" --token pcp_1234567890 https://example.test && printf ok'",
          aggregatedOutput: CANARY,
        },
      },
    });

    expect(redacted.event).toBe("command_started");
    expect(redacted.command).toContain("/bin/bash -lc");
    expect(redacted.command).toContain("printf ok");
    expect(redacted.command).not.toContain("hidden-token");
    expect(redacted.command).not.toContain("pcp_1234567890");
    expect(redacted.withheld).toEqual([
      "command output (not retained by the browser evidence boundary)",
    ]);
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });

  it("retains safe Codex tool details and identifies redacted credentials", () => {
    const redacted = redactCapabilityEvidenceData("provider_event", {
      method: "item/completed",
      params: {
        item: {
          type: "dynamicToolCall",
          tool: "paperclip_finish",
          namespace: "paperclip",
          status: "completed",
          arguments: { summary: "Done", apiKey: CANARY },
          result: { ok: true, note: "Recorded" },
        },
      },
    });

    expect(redacted).toMatchObject({
      event: "tool_completed",
      tool: "paperclip_finish",
      namespace: "paperclip",
      status: "completed",
      arguments: { summary: "Done", apiKey: "[redacted]" },
      result: { ok: true, note: "Recorded" },
    });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });

  it("collapses an unknown provider method rather than echoing it", () => {
    expect(redactCapabilityEvidenceData("provider_event", { method: `x/${CANARY}` })).toEqual({
      event: "other",
    });
  });

  it("withholds provider diagnostics and provider thread identity", () => {
    expect(redactCapabilityEvidenceData("diagnostic", { message: `PAPERCLIP_API_KEY=${CANARY}` })).toEqual({
      diagnostic: "withheld",
    });
    expect(
      redactCapabilityEvidenceData("session", {
        action: "started",
        sessionId: "session-1",
        providerThreadId: PROVIDER_THREAD,
        providerSessionId: `session_${CANARY}`,
        mode: "live_codex",
      }),
    ).toEqual({ action: "started", sessionId: "session-1", mode: "live_codex" });
  });

  it("drops process identifiers while keeping the transport transition", () => {
    expect(
      redactCapabilityEvidenceData("process", {
        action: "transport_closed",
        reason: "reconnect",
        runnerExited: true,
        runnerPid: 7100,
        codexPid: 7200,
      }),
    ).toEqual({ action: "transport_closed", reason: "reconnect", runnerExited: true });
  });

  it("keeps only the tool-call fields the catalog declares", () => {
    const redacted = redactCapabilityEvidenceData("tool_call", {
      callId: "call-1",
      operationId: "report_progress",
      beforeRevision: 1,
      input: { body: CANARY, idempotencyKey: "k", providerSecret: CANARY },
    });

    expect(redacted.input).toEqual({ fields: ["body", "idempotencyKey", "1 undeclared"] });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
    expect(JSON.stringify(redacted)).not.toContain("providerSecret");
  });

  it("carries the disposition summary the contract renders, and nothing else", () => {
    const redacted = redactCapabilityEvidenceData("tool_call", {
      callId: "call-2",
      operationId: "finish_task",
      beforeRevision: 4,
      input: { summary: "Spike wired to the mock control plane.", secret: CANARY },
    });

    expect(redacted.input).toEqual({
      fields: ["summary", "1 undeclared"],
      dispositionSummary: "Spike wired to the mock control plane.",
    });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });

  it("reduces a tool result to the outcome, revisions, and mock entity refs", () => {
    const redacted = redactCapabilityToolResult({
      ok: true,
      operationId: "get_task_context",
      callId: "call-3",
      stateRevision: 6,
      // A read operation returns whole mock records; none of it is public.
      result: {
        commandId: "cmd-1",
        disposition: "applied",
        stateRevision: 6,
        entityRefs: ["comment:comment-1"],
        detail: CANARY,
        task: { title: CANARY, description: CANARY },
      },
      detail: CANARY,
    });

    expect(redacted).toEqual({
      ok: true,
      stateRevision: 6,
      result: {
        commandId: "cmd-1",
        disposition: "applied",
        stateRevision: 6,
        entityRefs: ["comment:comment-1"],
      },
    });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });

  it("keeps our own denial copy, which the denial card renders verbatim", () => {
    const redacted = redactCapabilityToolResult({
      ok: false,
      denial: {
        schema: "paperclip.semantic-denial.v1",
        code: "required_claim_missing",
        message: "decide_approval requires the ap:decide claim.",
        retryable: false,
      },
      stateRevision: 3,
      providerEcho: CANARY,
    });

    expect(redacted.denial).toEqual({
      code: "required_claim_missing",
      message: "decide_approval requires the ap:decide claim.",
    });
    expect(JSON.stringify(redacted)).not.toContain(CANARY);
  });

  it("reports undeclared arguments as a count rather than by name", () => {
    expect(capabilityAllowlistedInputFields("report_progress", { body: "x", oops: 1, alsoOops: 2 })).toEqual([
      "body",
      "2 undeclared",
    ]);
    expect(capabilityAllowlistedInputFields("not_a_tool", { anything: 1 })).toEqual(["1 undeclared"]);
  });

  it("returns nothing for an unlisted evidence kind", () => {
    expect(redactCapabilityEvidenceData("cleanup", { reason: "shutdown", authorityCleared: true })).toEqual({
      reason: "shutdown",
      authorityCleared: true,
    });
    expect(
      redactCapabilityEvidenceData("interaction", {
        interactionId: "interaction-1",
        interactionKind: "questions",
        outcome: "answered",
        stateRevision: 5,
        result: { answers: { path: CANARY } },
      }),
    ).toEqual({
      interactionId: "interaction-1",
      interactionKind: "questions",
      outcome: "answered",
      stateRevision: 5,
    });
  });
});
