import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_TOOL_USE_META_KEY,
  ClaudeToolUseAdmission,
  TOOL_USE_ANNOUNCEMENT_WAIT_MS,
} from "./claude-tool-use-admission.js";

const live = () => new AbortController().signal;

afterEach(() => {
  vi.useRealTimers();
});

describe("Claude tool-use admission", () => {
  it("names the meta key the pinned Claude Code sends", () => {
    expect(CLAUDE_TOOL_USE_META_KEY).toBe("claudecode/toolUseId");
  });

  it("admits a tool use announced in the active turn and derives a stable call id", async () => {
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.announce("turn-1", "toolu_01A");
    await expect(admission.admit("turn-1", "toolu_01A", live())).resolves.toBe("tool-use:toolu_01A");
  });

  it("counts only an opening ACP tool_call event as an announcement", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.observe("turn-1", { type: "tool_call", tag: "tool_call_update", toolCallId: "toolu_update" });
    admission.observe("turn-1", { type: "status", tag: "tool_call", toolCallId: "toolu_status" });
    admission.observe("turn-1", { type: "tool_call", tag: "tool_call", toolCallId: "toolu_open" });
    await expect(admission.admit("turn-1", "toolu_open", live())).resolves.toBe("tool-use:toolu_open");
    for (const id of ["toolu_update", "toolu_status"]) {
      const outcome = admission.admit("turn-1", id, live()).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(TOOL_USE_ANNOUNCEMENT_WAIT_MS);
      expect(await outcome).toMatchObject({ message: "Paperclip tool call was not announced in the active turn" });
    }
  });

  it("admits a call that arrives before its announcement within the bound", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    const admitted = admission.admit("turn-1", "toolu_early", live());
    await vi.advanceTimersByTimeAsync(TOOL_USE_ANNOUNCEMENT_WAIT_MS - 1);
    admission.announce("turn-1", "toolu_early");
    await expect(admitted).resolves.toBe("tool-use:toolu_early");
  });

  it("rejects a call whose tool use is never announced once the bound elapses", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    const outcome = admission.admit("turn-1", "toolu_ghost", live()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(TOOL_USE_ANNOUNCEMENT_WAIT_MS - 1);
    admission.announce("turn-1", "toolu_other");
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ message: "Paperclip tool call was not announced in the active turn" });
    admission.announce("turn-1", "toolu_ghost");
    await expect(admission.admit("turn-1", "toolu_ghost", live())).resolves.toBe("tool-use:toolu_ghost");
  });

  it("rejects a waiting call as soon as its turn ends", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    const outcome = admission.admit("turn-1", "toolu_late", live()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10);
    admission.endTurn("turn-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ message: "Paperclip tool call was not announced in the active turn" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a waiting call when the provider cancels it", async () => {
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    const controller = new AbortController();
    const outcome = admission.admit("turn-1", "toolu_cancelled", controller.signal).catch((error: Error) => error);
    controller.abort();
    admission.announce("turn-1", "toolu_cancelled");
    expect(await outcome).toBeInstanceOf(Error);
  });

  it("does not let a later turn admit a tool use announced in an earlier turn", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.announce("turn-1", "toolu_turn1");
    admission.endTurn("turn-1");
    admission.beginTurn("turn-2");
    const outcome = admission.admit("turn-2", "toolu_turn1", live()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(TOOL_USE_ANNOUNCEMENT_WAIT_MS);
    expect(await outcome).toMatchObject({ message: "Paperclip tool call was not announced in the active turn" });
  });

  it("ignores announcements for a turn that is not active", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.announce("turn-1", "toolu_before");
    admission.beginTurn("turn-2");
    admission.announce("turn-1", "toolu_stale");
    for (const id of ["toolu_before", "toolu_stale"]) {
      const outcome = admission.admit("turn-2", id, live()).catch((error: Error) => error);
      await vi.advanceTimersByTimeAsync(TOOL_USE_ANNOUNCEMENT_WAIT_MS);
      expect(await outcome).toBeInstanceOf(Error);
    }
  });

  it("refuses a tool use already admitted, in the same turn or a later one", async () => {
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.announce("turn-1", "toolu_once");
    await admission.admit("turn-1", "toolu_once", live());
    await expect(admission.admit("turn-1", "toolu_once", live()))
      .rejects.toThrow("Paperclip tool call reused a provider tool-use identity");
    admission.endTurn("turn-1");
    admission.beginTurn("turn-2");
    admission.announce("turn-2", "toolu_once");
    await expect(admission.admit("turn-2", "toolu_once", live()))
      .rejects.toThrow("Paperclip tool call reused a provider tool-use identity");
  });

  it("admits only one of two concurrent calls waiting on the same tool use", async () => {
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    const first = admission.admit("turn-1", "toolu_twin", live()).then(id => id, (error: Error) => error);
    const second = admission.admit("turn-1", "toolu_twin", live()).then(id => id, (error: Error) => error);
    admission.announce("turn-1", "toolu_twin");
    const outcomes = await Promise.all([first, second]);
    expect(outcomes.filter(value => value === "tool-use:toolu_twin")).toHaveLength(1);
    expect(outcomes.filter(value => value instanceof Error)).toHaveLength(1);
  });

  it("attributes two turns' live calls by tool use after a cancelled turn", async () => {
    vi.useFakeTimers();
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.announce("turn-1", "toolu_0001");
    const turnOneCall = admission.admit("turn-1", "toolu_0001", live());
    await expect(turnOneCall).resolves.toBe("tool-use:toolu_0001");
    admission.announce("turn-1", "toolu_0001b");
    admission.endTurn("turn-1");
    admission.beginTurn("turn-2");
    admission.announce("turn-2", "toolu_0002");
    const late = admission.admit("turn-2", "toolu_0001b", live()).catch((error: Error) => error);
    await expect(admission.admit("turn-2", "toolu_0002", live())).resolves.toBe("tool-use:toolu_0002");
    await expect(admission.admit("turn-2", "toolu_0001", live())).rejects.toThrow("reused");
    admission.endTurn("turn-2");
    expect(await late).toMatchObject({ message: "Paperclip tool call was not announced in the active turn" });
  });

  it("admits a subagent's child tool use announced in the active turn", async () => {
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.announce("turn-1", "toolu_agent");
    admission.announce("turn-1", "toolu_child");
    await expect(admission.admit("turn-1", "toolu_child", live())).resolves.toBe("tool-use:toolu_child");
  });

  it.each([undefined, "", "toolu bad", "_toolu", "x".repeat(129)])("rejects a call without a usable tool-use id: %s", async id => {
    const admission = new ClaudeToolUseAdmission();
    admission.beginTurn("turn-1");
    admission.announce("turn-1", id);
    await expect(admission.admit("turn-1", id, live()))
      .rejects.toThrow("Paperclip tool call has no provider tool-use identity");
  });

  it("rejects a call for a turn that is not active without waiting", async () => {
    const admission = new ClaudeToolUseAdmission();
    await expect(admission.admit("turn-1", "toolu_idle", live())).rejects.toThrow("not bound to the active turn");
    admission.beginTurn("turn-2");
    admission.announce("turn-2", "toolu_idle");
    await expect(admission.admit("turn-1", "toolu_idle", live())).rejects.toThrow("not bound to the active turn");
  });

  it("has room for another turn only while a full turn of admissions still fits its ledger", async () => {
    const admission = new ClaudeToolUseAdmission();
    expect(admission.hasRoomForAnotherTurn()).toBe(true);
    admission.beginTurn("turn-1");
    for (let index = 0; index < 4_096; index += 1) {
      const id = `toolu_first${index}`;
      admission.announce("turn-1", id);
      await admission.admit("turn-1", id, live());
    }
    admission.endTurn("turn-1");
    expect(admission.hasRoomForAnotherTurn()).toBe(true);
    admission.beginTurn("turn-2");
    admission.announce("turn-2", "toolu_second");
    await admission.admit("turn-2", "toolu_second", live());
    admission.endTurn("turn-2");
    expect(admission.hasRoomForAnotherTurn()).toBe(false);
  });
});
