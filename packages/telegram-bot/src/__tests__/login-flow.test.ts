import { describe, it, expect, afterEach } from "vitest";
import { CodeStore } from "../state/code-store.js";
import { ReplyStore } from "../state/reply-store.js";
import { PaperclipClient } from "../api/paperclip-client.js";
import { loginCommand } from "../commands/login.js";
import { startInternalServer, type InternalServerHandle } from "../internal-server.js";
import { mockFetch, makeCtx } from "./helpers.js";
import type { CommandDeps } from "../commands/types.js";

let handle: InternalServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe("end-to-end /login → backend resolveCode", () => {
  it("issues a code via /login and lets the backend exchange it for chat-id", async () => {
    const codeStore = new CodeStore();
    const replyStore = new ReplyStore();
    const client = new PaperclipClient({
      baseUrl: "http://test.local",
      apiKey: "bot-key",
      companyId: "co",
      fetchImpl: mockFetch(() => ({ status: 200, body: {} })),
    });
    const deps: CommandDeps = { client, codeStore, replyStore };
    const { ctx, replies } = makeCtx("/login", { chatId: "9001", tgUsername: "dinar" });

    await loginCommand(ctx, deps);
    const code = replies[0]?.match(/`(\d{6})`/)![1]!;

    handle = await startInternalServer({ codeStore, secret: "shh", port: 0 });
    const url = `http://127.0.0.1:${handle.port}/internal/resolve-code?code=${code}`;

    const res = await fetch(url, { headers: { "X-Internal-Secret": "shh" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tgChatId: string; tgUsername: string | null };
    expect(body.tgChatId).toBe("9001");
    expect(body.tgUsername).toBe("dinar");

    // Backend would now persist the link. Reusing the same code must fail.
    const reused = await fetch(url, { headers: { "X-Internal-Secret": "shh" } });
    expect(reused.status).toBe(404);
  });
});
