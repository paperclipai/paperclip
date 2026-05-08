import { describe, it, expect } from "vitest";
import { approveCommand, denyCommand } from "../commands/approve.js";
import { mockFetch, makeDeps, makeCtx } from "./helpers.js";

describe("/approve and /deny", () => {
  it("/approve hits POST /api/approvals/:id/approve", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: { ok: true } }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/approve apv-7", { chatId: "111" });

    await approveCommand(ctx, deps);

    expect(fetchImpl.calls[0]?.method).toBe("POST");
    expect(fetchImpl.calls[0]?.url).toBe("http://test.local/api/approvals/apv-7/approve");
    expect(fetchImpl.calls[0]?.headers["x-telegram-chat-id"]).toBe("111");
    expect(replies[0]).toMatch(/одобрен/);
  });

  it("/deny hits POST /api/approvals/:id/reject", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: { ok: true } }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/deny apv-7");

    await denyCommand(ctx, deps);

    expect(fetchImpl.calls[0]?.url).toBe("http://test.local/api/approvals/apv-7/reject");
    expect(replies[0]).toMatch(/отклонён/);
  });

  it("rejects empty arg", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: {} }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/approve");

    await approveCommand(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(replies[0]).toMatch(/Использование/);
  });

  it("surfaces server errors", async () => {
    const fetchImpl = mockFetch(() => ({ status: 404, body: { error: "not found" } }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/approve apv-x");

    await approveCommand(ctx, deps);

    expect(replies[0]).toMatch(/Не удалось одобрить/);
  });
});
