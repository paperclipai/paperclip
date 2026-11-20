import { describe, it, expect, vi } from "vitest";
import { CODEX_METHOD_NOT_FOUND, CodexRpcError } from "./app-server-transport.js";
import {
  readCodexThreadState,
  readCodexTurnMetadata,
  readCodexTurnItems,
} from "./codex-history.js";

const unsupported = (method: string) => new CodexRpcError(`${method} is not supported`, CODEX_METHOD_NOT_FOUND);

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
  it("does not turn an unsupported later page into idle history", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ data: [], nextCursor: "next" })
      .mockRejectedValueOnce(unsupported("thread/turns/list"));
    await expect(readCodexTurnMetadata({ request }, "thread")).rejects.toThrow(
      "supported paginated history",
    );
    expect(request.mock.calls.map(call => call[0])).toEqual(["thread/turns/list", "thread/turns/list"]);
  });
  it("names a failed history read as a failed read, not as unsupported history", async () => {
    const timeout = new Error("provider_transport_failed: PRP command session.snapshot timed out (runner connected; pending ahead 0)");
    const request = vi.fn().mockRejectedValueOnce(timeout);
    await expect(readCodexTurnMetadata({ request }, "thread")).rejects.toThrow(
      `codex_history_read_failed: thread/turns/list read failed; Error: ${timeout.message}`,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("reads complete turn history from the thread when paginated history is unsupported", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/turns/list") throw unsupported(method);
      return { thread: { id: "thread", turns: [
        { id: "one", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "done" }] },
        { id: "two", status: "inProgress", items: [] },
      ] } };
    });
    expect(await readCodexTurnMetadata({ request }, "thread")).toEqual([
      { id: "one", status: "completed", items: [], itemsView: "notLoaded" },
      { id: "two", status: "inProgress", items: [], itemsView: "notLoaded" },
    ]);
    expect(request).toHaveBeenLastCalledWith("thread/read", { threadId: "thread", includeTurns: true });
  });
  it("reads a turn's items from the thread when paginated items are unsupported", async () => {
    const answer = { id: "answer", type: "agentMessage", text: "done" };
    const request = vi.fn(async (method: string) => {
      if (method === "thread/items/list") throw unsupported(method);
      return { thread: { id: "thread", turns: [
        { id: "one", status: "completed", items: [answer] },
        { id: "two", status: "inProgress", items: [{ id: "other" }] },
      ] } };
    });
    expect(await readCodexTurnItems({ request }, "thread", "one")).toEqual([answer]);
  });
  it.each([
    ["another thread", { thread: { id: "other", turns: [] } }, "different driver session"],
    ["no turns", { thread: { id: "thread" } }, "supported paginated history"],
    ["a turn without a status", { thread: { id: "thread", turns: [{ id: "one" }] } }, "codex_history_incomplete"],
    ["a turn without an id", { thread: { id: "thread", turns: [{ status: "completed" }] } }, "codex_history_incomplete"],
  ])("fails closed when the unpaginated thread read returns %s", async (_case, thread, message) => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/turns/list") throw unsupported(method);
      return thread;
    });
    await expect(readCodexTurnMetadata({ request }, "thread")).rejects.toThrow(message);
  });
  it("fails closed when the unpaginated thread read omits the requested turn's items", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "thread/items/list") throw unsupported(method);
      return { thread: { id: "thread", turns: [{ id: "one", status: "completed" }] } };
    });
    await expect(readCodexTurnItems({ request }, "thread", "one")).rejects.toThrow("codex_history_incomplete");
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
