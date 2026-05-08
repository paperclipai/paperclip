import { describe, it, expect } from "vitest";
import { makeTaskCommand } from "../commands/task.js";
import { mockFetch, makeDeps, makeCtx } from "./helpers.js";

const CEO = "262a08ea-c041-4af7-a310-e2a0fedc8348";

describe("/task", () => {
  it("rejects empty arg", async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: {} }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/task   ");

    await makeTaskCommand({ ceoAgentId: CEO })(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(0);
    expect(replies[0]).toMatch(/Использование/);
  });

  it("creates an issue against CEO with X-Telegram-Chat-Id and bot bearer", async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: {
        id: "issue-1",
        identifier: "THE-999",
        title: "Поправить онбординг",
        status: "open",
      },
    }));
    const deps = makeDeps({ fetchImpl, companyId: "co-42" });
    const { ctx, replies } = makeCtx("/task Поправить онбординг", { chatId: "777" });

    await makeTaskCommand({ ceoAgentId: CEO })(ctx, deps);

    expect(fetchImpl.calls).toHaveLength(1);
    const call = fetchImpl.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("http://test.local/api/companies/co-42/issues");
    expect(call.headers["authorization"]).toBe("Bearer bot-key");
    expect(call.headers["x-telegram-chat-id"]).toBe("777");
    expect(call.body).toEqual({
      title: "Поправить онбординг",
      description: "Поправить онбординг",
      assigneeAgentId: CEO,
    });
    expect(replies[0]).toContain("THE-999");
  });

  it("reports unauthenticated chat as a friendly error", async () => {
    const fetchImpl = mockFetch(() => ({ status: 401, body: { error: "unauth" } }));
    const deps = makeDeps({ fetchImpl });
    const { ctx, replies } = makeCtx("/task сделай X");

    await makeTaskCommand({ ceoAgentId: CEO })(ctx, deps);

    expect(replies[0]).toMatch(/Telegram-аккаунт не привязан/);
  });
});
