import { describe, expect, it } from "vitest";
import { antigravitySwarmEvent, createAntigravityTerminalHintFilter, stripAntigravityTerminalHints } from "./antigravity-swarm-presentation.js";

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
      .toMatchObject({ title: "Goal: Two writers and a verifier", paperclipToolDetail: { toolName: "swarm_update", subject: "Goal: Two writers and a verifier" } });
  });

  it("keeps the opening title on later updates of the same call", () => {
    expect(antigravitySwarmEvent(tool("read_board", { since: 5 }, "tool_call_update", "completed"), WORKSPACE))
      .toMatchObject({ type: "tool_call", tag: "tool_call_update", status: "completed", title: "Checked on the helpers" });
  });

  it("drops terminal-only hints from the coordinator's text", () => {
    expect(stripAntigravityTerminalHints("Launched.\n\nRun /swarm board (default shortcut alt+s) to open the live board."))
      .toBe("Launched.\n");
  });

  const filtered = (chunks: string[]) => {
    const filter = createAntigravityTerminalHintFilter();
    return chunks.map(chunk => filter.push(chunk)).join("") + filter.flush();
  };

  it("drops a terminal hint the CLI streams in pieces, with its trailing period (live run7)", () => {
    // ANT-35: the hint split after "(".
    expect(filtered(["- `verifier`: Checks all five files.\n\nRun /swarm board (", "default shortcut alt+s) to open the live board."]))
      .toBe("- `verifier`: Checks all five files.\n");
    // ANT-31: the period arrived alone, and left a stray "." line.
    expect(filtered([" once notified by the creators.\n", "Run /swarm board (default shortcut alt+s) to open the live board", ".", "\n\nThe task has been completed"]))
      .toBe(" once notified by the creators.\n\nThe task has been completed");
  });

  it("drops the hint wherever the CLI splits it, and changes nothing else", () => {
    const text = "Launched.\n\nRun /swarm board (default shortcut alt+s) to open the live board.\n\nDone. Run the tests (npm test).";
    for (let size = 1; size <= 12; size++) {
      const chunks = Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
      expect(filtered(chunks)).toBe("Launched.\n\n\nDone. Run the tests (npm test).");
    }
    expect(filtered(["Run", " the build. R", "eady."])).toBe("Run the build. Ready.");
  });
});
