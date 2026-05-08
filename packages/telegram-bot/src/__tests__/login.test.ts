import { describe, it, expect } from "vitest";
import { loginCommand } from "../commands/login.js";
import { mockFetch, makeDeps, makeCtx } from "./helpers.js";

describe("/login", () => {
  it("issues a 6-digit code and stores it for resolution", async () => {
    const deps = makeDeps({ fetchImpl: mockFetch(() => ({ status: 200, body: {} })) });
    const { ctx, replies } = makeCtx("/login", { chatId: "42", tgUsername: "dinar" });

    await loginCommand(ctx, deps);

    expect(replies).toHaveLength(1);
    const match = replies[0]?.match(/`(\d{6})`/);
    expect(match).not.toBeNull();
    const code = match![1]!;
    const entry = deps.codeStore.consume(code);
    expect(entry?.chatId).toBe("42");
    expect(entry?.tgUsername).toBe("dinar");
  });
});
