import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { startRollingDeploymentProxy } from "./rolling-deployment-proxy.js";

it("switches new traffic without replaying or cutting an admitted write", async () => {
  const writes: string[] = [];
  let accept!: () => void;
  let finish!: () => void;
  const accepted = new Promise<void>(resolve => { accept = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const a = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    writes.push(body); accept();
    await pending;
    res.end("saved by A");
  });
  const b = createServer((_req, res) => res.end("served by B"));
  const proxy = await startRollingDeploymentProxy();
  try {
    a.listen(0, "127.0.0.1"); await once(a, "listening");
    b.listen(0, "127.0.0.1"); await once(b, "listening");
    const origin = (server: typeof a) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    proxy.routeTo(origin(a));
    const saved = fetch(proxy.origin, { method: "POST", body: "one accepted mutation" });
    await accepted;
    proxy.routeTo(origin(b));
    expect(await (await fetch(proxy.origin)).text()).toBe("served by B");
    finish();
    expect(await (await saved).text()).toBe("saved by A");
    expect(writes).toEqual(["one accepted mutation"]);
  } finally {
    finish();
    await proxy.close();
    await Promise.all([a, b].map(server => new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    })));
  }
});

it("reports a failed backend write without retrying it", async () => {
  let accepted = 0;
  const backend = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the accepted body */ }
    accepted++;
    res.destroy();
  });
  const proxy = await startRollingDeploymentProxy();
  try {
    backend.listen(0, "127.0.0.1"); await once(backend, "listening");
    proxy.routeTo(`http://127.0.0.1:${(backend.address() as { port: number }).port}`);
    expect((await fetch(proxy.origin, { method: "POST", body: "accepted then disconnected" })).status).toBe(502);
    expect(accepted).toBe(1);
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections(); });
  }
});
