import { describe, it, expect, afterEach } from "vitest";
import { CodeStore } from "../state/code-store.js";
import { startInternalServer, type InternalServerHandle } from "../internal-server.js";

let handle: InternalServerHandle | null = null;

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
});

describe("internal-server /internal/resolve-code", () => {
  it("returns tgChatId for a valid code with correct secret, then 404 on reuse", async () => {
    const codeStore = new CodeStore();
    const { code } = codeStore.issue({ chatId: "777", tgUsername: "dinar" });
    handle = await startInternalServer({
      codeStore,
      secret: "shh",
      port: 0,
    });
    const url = `http://127.0.0.1:${handle.port}/internal/resolve-code?code=${code}`;

    const ok = await fetch(url, { headers: { "X-Internal-Secret": "shh" } });
    expect(ok.status).toBe(200);
    const json = (await ok.json()) as { tgChatId: string; tgUsername: string | null };
    expect(json.tgChatId).toBe("777");
    expect(json.tgUsername).toBe("dinar");

    const reuse = await fetch(url, { headers: { "X-Internal-Secret": "shh" } });
    expect(reuse.status).toBe(404);
  });

  it("rejects wrong secret with 401", async () => {
    const codeStore = new CodeStore();
    handle = await startInternalServer({ codeStore, secret: "shh", port: 0 });
    const url = `http://127.0.0.1:${handle.port}/internal/resolve-code?code=000000`;
    const res = await fetch(url, { headers: { "X-Internal-Secret": "wrong" } });
    expect(res.status).toBe(401);
  });

  it("returns 404 for missing/expired code", async () => {
    const codeStore = new CodeStore();
    handle = await startInternalServer({ codeStore, secret: "shh", port: 0 });
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/internal/resolve-code?code=000000`,
      { headers: { "X-Internal-Secret": "shh" } },
    );
    expect(res.status).toBe(404);
  });
});
