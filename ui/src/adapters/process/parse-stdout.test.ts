import { describe, expect, it } from "vitest";
import { parseProcessStdoutLine } from "./parse-stdout";

const TS = "2026-09-09T12:00:00.000Z";

function planLine(overrides: Record<string, unknown> = {}, event: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "tool_execution_end",
    toolCallId: "call_abc",
    toolName: "delivery_update_plan",
    result: {
      content: [{ type: "text", text: "Plan rev 2: 1/3 done" }],
      details: {
        schema: "paperclip.plan.updated.v1",
        planId: "run-plan",
        revision: 2,
        complete: false,
        explanation: "Working through the checklist.",
        steps: [
          { stepId: "s1", body: "Inspect adapter", status: "completed" },
          { stepId: "s2", body: "Wire parser", status: "in_progress" },
        ],
        ...overrides,
      },
    },
    isError: false,
    ...event,
  });
}

describe("process stdout parser", () => {
  it("keeps plain stdout lines as stdout", () => {
    expect(parseProcessStdoutLine("  plain shell output  ", TS)).toEqual([
      { kind: "stdout", ts: TS, text: "  plain shell output  " },
    ]);
  });

  it("renders recognized Pi events with the Pi parser", () => {
    const line = JSON.stringify({
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "read",
      args: { path: "src/index.ts" },
    });
    expect(parseProcessStdoutLine(line, TS)).toEqual([
      { kind: "tool_call", ts: TS, name: "read", input: { path: "src/index.ts" }, toolUseId: "call_1" },
    ]);
  });

  it("keeps unknown JSON object events as stdout", () => {
    const line = JSON.stringify({ type: "some_future_event", payload: { n: 1 } });
    expect(parseProcessStdoutLine(line, TS)).toEqual([{ kind: "stdout", ts: TS, text: line }]);
  });

  it("emits the normal tool result plus a structured plan entry for delivery_update_plan", () => {
    const entries = parseProcessStdoutLine(planLine(), TS);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_abc", toolName: "delivery_update_plan", isError: false }),
      {
        kind: "provider_activity",
        ts: TS,
        family: "plan",
        eventType: "plan.updated",
        status: "running",
        title: "Plan",
        summary: "Working through the checklist.",
        payload: {
          schema: "paperclip.plan.updated.v1",
          planId: "run-plan",
          revision: 2,
          explanation: "Working through the checklist.",
          steps: [
            { stepId: "s1", body: "Inspect adapter", status: "completed" },
            { stepId: "s2", body: "Wire parser", status: "in_progress" },
          ],
          complete: false,
          syncStatus: "not_applicable",
          documentRevision: null,
        },
      },
    ]);
  });

  it("marks the plan completed when the snapshot is complete", () => {
    const entries = parseProcessStdoutLine(planLine({ complete: true }), TS);
    const plan = entries.find((entry) => entry.kind === "provider_activity");
    expect(plan).toMatchObject({ status: "completed", payload: { complete: true } });
  });

  it("ignores the plan on tool error without swallowing the tool result", () => {
    const entries = parseProcessStdoutLine(planLine({}, { isError: true }), TS);
    expect(entries.some((entry) => entry.kind === "provider_activity")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_abc", isError: true }),
    ]);
  });

  it("ignores other tool names and non-plan schemas without swallowing", () => {
    const otherTool = JSON.parse(planLine());
    otherTool.toolName = "read";
    expect(
      parseProcessStdoutLine(JSON.stringify(otherTool), TS).some(
        (entry) => entry.kind === "provider_activity",
      ),
    ).toBe(false);

    const wrongSchema = planLine({ schema: "paperclip.plan.updated.v0" });
    const entries = parseProcessStdoutLine(wrongSchema, TS);
    expect(entries.some((entry) => entry.kind === "provider_activity")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolName: "delivery_update_plan" }),
    ]);
  });


  it("keeps a malformed plan payload visible as a normal tool result", () => {
    const line = JSON.stringify({
      type: "tool_execution_end",
      toolCallId: "call_bad",
      toolName: "delivery_update_plan",
      result: { content: [{ type: "text", text: "oops" }] },
      isError: false,
    });
    const entries = parseProcessStdoutLine(line, TS);
    expect(entries.some((entry) => entry.kind === "provider_activity")).toBe(false);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "tool_result", toolUseId: "call_bad" }),
    ]);
  });
});
