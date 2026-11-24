import { describe, expect, it } from "vitest";
import { antigravitySwarmEvent, stripAntigravityTerminalHints } from "./antigravity-swarm-presentation.js";

const WORKSPACE = "/work/task";
const tool = (name: string, args: Record<string, unknown>, sessionUpdate = "tool_call", status = "in_progress") =>
  ({ sessionUpdate, toolCallId: "call_14003112185197785061", name, args, rawInput: args, status, kind: "other", title: `Run ${name}` });

describe("Antigravity swarm activity, in plain language", () => {
  it("names helpers by role and what they were asked to do, never by id", () => {
    const event = antigravitySwarmEvent(tool("swarm", { action: "add", name: "writer-a", workspace: "inherit",
      brief: `Write a.txt containing exactly 'A' in ${WORKSPACE}. Once done, post to the board: '@verifier [done] a.txt written'.` }), WORKSPACE);
    expect(event).toMatchObject({ type: "tool_call", title: "Started helper writer-a: Write a.txt containing exactly 'A' in the task folder" });
    expect((event as { title?: string } | null)?.title).not.toMatch(/call_|@verifier/);
    expect(event).not.toHaveProperty("rawInput");
    expect(antigravitySwarmEvent(tool("swarm", { action: "add", name: "monitor", brief: "You are this swarm's stall monitor. Load the swarm_monitor skill." }), WORKSPACE))
      .toMatchObject({ title: "Started a helper that watches for stalls" });
  });

  it("describes board activity without the provider's tool names", () => {
    expect(antigravitySwarmEvent(tool("read_board", { since: 5 }), WORKSPACE)).toMatchObject({ title: "Checked on the helpers" });
    expect(antigravitySwarmEvent(tool("post_message", { text: "@verifier [done] Verification verified: checked 2 files" }), WORKSPACE))
      .toMatchObject({ title: "Coordinator: Verification verified: checked 2 files" });
    expect(antigravitySwarmEvent(tool("swarm", { action: "title", title: "Two writers and a verifier" }), WORKSPACE))
      .toMatchObject({ title: "Swarm: Two writers and a verifier" });
  });

  it("keeps the opening title on later updates of the same call", () => {
    expect(antigravitySwarmEvent(tool("read_board", { since: 5 }, "tool_call_update", "completed"), WORKSPACE))
      .toMatchObject({ type: "tool_call", tag: "tool_call_update", status: "completed", title: "Checked on the helpers" });
  });

  it("drops terminal-only hints from the coordinator's text", () => {
    expect(stripAntigravityTerminalHints("Launched.\n\nRun /swarm board (default shortcut alt+s) to open the live board."))
      .toBe("Launched.\n");
  });
});
