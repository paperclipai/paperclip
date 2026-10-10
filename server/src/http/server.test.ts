import { once } from "node:events";
import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";
import { registerRunnerPrpAuthority, runnerPrpWebSocketInternals } from "../realtime/runner-prp-ws.js";
import { createPaperclipHttpServer } from "./server.js";

describe("Paperclip HTTP server runner transport", () => {
  afterEach(() => runnerPrpWebSocketInternals.resetForTests());

  it("registers native runner authority without a separate startup call", async () => {
    const server = createPaperclipHttpServer((_req, res) => res.end("ok"), {
      apiUrl: "http://127.0.0.1:3210",
    });
    const handleUpgrade = vi.fn();
    const runId = "00000000-0000-4000-8000-000000000777";
    const authority = await registerRunnerPrpAuthority({
      companyId: "company-1", runId,
      authority: { handleUpgrade } as unknown as DurablePrpControlPlane,
    });
    expect(authority.connectUrl).toBe(`ws://127.0.0.1:3210/api/runner/v1/connect/${runId}`);
    expect(server.listenerCount("upgrade")).toBe(1);
    await authority.release();
    server.close();
  });

  it("serves HTTP and rejects an unregistered runner over the real listener", async () => {
    const server = createPaperclipHttpServer((_req, res) => res.end("ready"), {
      apiUrl: "http://127.0.0.1:3210",
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Listener not bound");
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      expect(await (await fetch(origin)).text()).toBe("ready");
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${origin}/api/runner/v1/connect/00000000-0000-4000-8000-000000000778`, {
          headers: { connection: "Upgrade", upgrade: "websocket" },
        }, res => { res.resume(); resolve(res.statusCode); });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("Runner upgrade was not handled")));
        req.end();
      });
      expect(status).toBe(404);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
