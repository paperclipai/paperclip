import { describe, it, expect, vi } from "vitest";
import {
  readCodexThreadState,
  readCodexTurnMetadata,
  readCodexTurnItems,
} from "./codex-history.js";

describe("Codex paginated history", () => {
  it("reads state without hydrating history", async () => {
    const request = vi.fn().mockResolvedValue({ thread: { id: "thread" } });
    await readCodexThreadState({ request }, "thread");
    expect(request).toHaveBeenCalledExactlyOnceWith("thread/read", {
      threadId: "thread",
      includeTurns: false,
    });
  });
  it("follows empty pages and preserves ordering while updating duplicate turn anchors", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "one", status: "inProgress" }],
        nextCursor: "a",
      })
      .mockResolvedValueOnce({ data: [], nextCursor: "b" })
      .mockResolvedValueOnce({
        data: [
          { id: "one", status: "completed" },
          { id: "two", status: "inProgress" },
        ],
        nextCursor: null,
      });
    expect(await readCodexTurnMetadata({ request }, "thread")).toEqual([
      { id: "one", status: "completed" },
      { id: "two", status: "inProgress" },
    ]);
    expect(request.mock.calls.map((call) => call[1].cursor)).toEqual([
      undefined,
      "a",
      "b",
    ]);
    expect(
      request.mock.calls.every((call) => call[1].itemsView === "notLoaded"),
    ).toBe(true);
  });
  it("loads full items only for the requested turn and deduplicates stable IDs", async () => {
    const command = {
      turnId: "one",
      item: { id: "cmd", type: "commandExecution", exitCode: 0 },
    };
    const answer = {
      turnId: "one",
      item: { id: "answer", type: "agentMessage", text: "saved answer" },
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [command], nextCursor: "a" })
      .mockResolvedValueOnce({ data: [command, answer] });
    expect(await readCodexTurnItems({ request }, "thread", "one")).toEqual([
      command.item,
      answer.item,
    ]);
    expect(
      request.mock.calls.every(
        (call) => call[0] === "thread/items/list" && call[1].turnId === "one",
      ),
    ).toBe(true);
  });
  it.each([
    [
      { data: [], nextCursor: "a" },
      { data: [], nextCursor: "a" },
    ],
    [{ data: [], nextCursor: "a" }, {}],
    [{ data: [{ id: "one" }] }],
  ])("rejects incomplete history", async (...pages) => {
    const request = vi.fn();
    for (const page of pages) request.mockResolvedValueOnce(page);
    await expect(readCodexTurnMetadata({ request }, "thread")).rejects.toThrow(
      "codex_history_incomplete",
    );
  });
  it("does not turn an interrupted page or unsupported method into idle history", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [], nextCursor: "next" })
      .mockRejectedValueOnce(new Error("method not found"));
    await expect(readCodexTurnMetadata({ request }, "thread")).rejects.toThrow(
      "supported paginated history",
    );
  });
  it("rejects another thread or turn", async () => {
    await expect(
      readCodexThreadState(
        { request: vi.fn().mockResolvedValue({ thread: { id: "other" } }) },
        "thread",
      ),
    ).rejects.toThrow("different driver session");
    await expect(
      readCodexTurnItems(
        {
          request: vi
            .fn()
            .mockResolvedValue({
              data: [{ turnId: "other", item: { id: "a" } }],
            }),
        },
        "thread",
        "one",
      ),
    ).rejects.toThrow("different turn");
  });
});
