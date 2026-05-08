import { describe, it, expect } from "vitest";
import { replyHandler } from "../commands/reply.js";
import { mockFetch, makeDeps, makeCtx } from "./helpers.js";

describe("reply-to-notification", () => {
  it("posts comment to issue when replying to a remembered notification", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: { id: "c-1", body: "ack" },
    }));
    const deps = makeDeps({ fetchImpl });
    deps.replyStore.remember("55555", 42, { issueId: "issue-7" });
    const { ctx, replies } = makeCtx("ack", { replyToMessageId: 42 });

    await replyHandler(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]?.url).toBe("http://test.local/api/issues/issue-7/comments");
    expect(fetchImpl.calls[0]?.method).toBe("POST");
    expect(fetchImpl.calls[0]?.body).toEqual({ body: "ack" });
    expect(replies[0]).toMatch(/добавлен/);
  });

  it("ignores message that isn't a reply", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: {} }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("hello", { replyToMessageId: null });

    await replyHandler(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });

  it("ignores reply to unknown message id", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: {} }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("hi", { replyToMessageId: 999 });

    await replyHandler(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(replies).toHaveLength(0);
  });
});
