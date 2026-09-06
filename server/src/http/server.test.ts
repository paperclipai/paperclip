import { afterEach, describe, expect, it } from "bun:test";
import { createHttpApp } from "./app.js";

describe("HTTP server boundary", () => {
  const servers: Bun.Server<undefined>[] = [];

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  it("serves the HTTP application through Bun without changing its route contract", async () => {
    const app = createHttpApp({
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      authReady: true,
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    servers.push(server);

    const response = await fetch(`http://${server.hostname}:${server.port}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()) as { status: string }).toMatchObject({ status: "ok" });
  });
});
