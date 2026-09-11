import { describe, expect, it } from "vitest";

import {
  SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
  safeNativeChatProgressForEvent,
} from "./safe-native-chat-progress.js";

describe("safe native chat progress", () => {
  it.each([
    ["workspace.ready", "preparing", "Maya is preparing…"],
    ["research.progressed", "researching", "Maya is doing research…"],
    ["tool.execution.completed", "using_tools", "Maya is using tools…"],
    ["item.completed", "making_progress", "Maya is making progress…"],
    ["delegation.updated", "coordinating", "Maya is coordinating work…"],
    [
      "workspace.diff.recorded",
      "working_with_files",
      "Maya is working with files…",
    ],
    ["artifact.generated", "working_with_files", "Maya is working with files…"],
  ] as const)(
    "maps exact %s events to closed provider prose",
    (eventType, phase, text) => {
      expect(safeNativeChatProgressForEvent(eventType, "Maya")).toEqual({
        phase,
        text,
      });
    },
  );

  it.each([
    "item.started",
    "item.delta",
    "semantic_tool.input",
    "semantic_tool.result",
    "provider.notice",
    "harness.diagnostic",
    "paperclip.provider_startup.v1",
    "run.result.proposed",
    "run.terminal",
    "runtime_request.completed",
    "tool.execution.future_event",
    "reasoning.completed",
    "error",
  ])("fails closed for non-allowlisted event type %s", (eventType) => {
    expect(safeNativeChatProgressForEvent(eventType, "Maya")).toBeNull();
  });

  it("does not accept prefixes, suffixes, or event-controlled prose", () => {
    const secret = "PRIVATE-TOOL-ARGUMENT";
    expect(
      safeNativeChatProgressForEvent(
        `tool.execution.started:${secret}`,
        "Maya",
      ),
    ).toBeNull();
    expect(
      safeNativeChatProgressForEvent(`prefix.tool.execution.started`, "Maya"),
    ).toBeNull();
    expect(
      safeNativeChatProgressForEvent(`item.completed ${secret}`, "Maya"),
    ).toBeNull();
    expect(JSON.stringify(SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES)).not.toContain(
      secret,
    );
  });
});
