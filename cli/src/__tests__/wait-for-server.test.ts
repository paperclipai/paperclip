import { createServer, type Server, type RequestListener } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { waitForServer } from "./helpers/wait-for-server.js";

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function serve(handler: RequestListener) {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  return `http://127.0.0.1:${address.port}`;
}

const output = { stdout: ["startup recovery in progress"], stderr: ["diagnostic"] };

describe("CLI fixture readiness deadline", () => {
  it("requires successful health after startup, not merely a bound listener", async () => {
    let probes = 0;
    const url = await serve((_req, res) => {
      res.writeHead(++probes === 1 ? 503 : 200).end();
    });
    await waitForServer(url, { exitCode: null }, output, Date.now() + 2_000);
    expect(probes).toBe(2);
  });

  it("bounds a health request that never answers by the remaining setup budget", async () => {
    const url = await serve(() => {});
    await expect(waitForServer(url, { exitCode: null }, output, Date.now() + 50))
      .rejects.toThrow("Timed out waiting");
  });

  it("keeps diagnostics when the shared setup budget is exhausted", async () => {
    await expect(waitForServer("http://127.0.0.1:1", { exitCode: null }, output, Date.now() - 1))
      .rejects.toThrow("startup recovery in progress\nstderr:\ndiagnostic");
  });

  it("fails immediately if the child exits before readiness", async () => {
    await expect(waitForServer("http://127.0.0.1:1", { exitCode: 1 }, output, Date.now() + 1_000))
      .rejects.toThrow("exited before healthcheck succeeded");
  });
});
