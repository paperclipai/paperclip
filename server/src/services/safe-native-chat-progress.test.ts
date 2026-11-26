import { describe, expect, it } from "vitest";

import {
  SAFE_NATIVE_CHAT_PROGRESS_EVENT_TYPES,
  safeNativeChatProgressForEvent,
  publicNativeChatProgressText,
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

const publicEvent = (channel = "progress", kind = "agentMessage", text = "Found the retry bug. Checking recovery next.") => ({
  prpEvent: { schema: "paperclip.prp.event.v1", eventType: "item.completed", runId: "run-1",
    payload: { kind, channel, text } },
});
describe("public native progress", () => {
  it("selects only completed public commentary from the bound run", () => {
    expect(publicNativeChatProgressText("item.completed", publicEvent(), "run-1")).toBe("Found the retry bug. Checking recovery next.");
    expect(publicNativeChatProgressText("item.delta", publicEvent(), "run-1")).toBeNull();
    expect(publicNativeChatProgressText("item.completed", publicEvent(), "other-run")).toBeNull();
  });
  it.each(["summary", "detail", "unknown", "final", "commentary"])("rejects the unmapped %s channel", channel => {
    expect(publicNativeChatProgressText("item.completed", publicEvent(channel), "run-1")).toBeNull();
  });
  it("rejects tool and reasoning items even with a public channel", () => {
    for (const kind of ["reasoning", "commandExecution", "toolCall"])
      expect(publicNativeChatProgressText("item.completed", publicEvent("progress", kind), "run-1")).toBeNull();
  });
  it("keeps two sentences and redacts credentials and broadcast mentions", () => {
    const input = publicEvent("progress", "agentMessage", 'Checking @channel with token="secret123". Testing recovery. More details follow.');
    const text = publicNativeChatProgressText("item.completed", input, "run-1");
    expect(text).toContain("Testing recovery.");
    expect(text).not.toContain("More details");
    expect(text).not.toContain("secret123");
    expect(text).not.toContain("@channel");
  });
  it("sanitizes before bounding and keeps complete sentences", () => {
    const text = "<thinking>PRIVATE</thinking>Checking  retries. " + "A".repeat(450);
    expect(publicNativeChatProgressText("item.completed", publicEvent("progress", "agentMessage", text), "run-1")).toBe("Checking retries.");
    expect(publicNativeChatProgressText("item.completed", publicEvent("progress", "agentMessage", "x".repeat(450)), "run-1")).toBeNull();
  });
});
