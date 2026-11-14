/** Explicit offline privacy canary only; never included by runner.spec discovery. */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { RunnerApi } from "./api.js";
test("owned API transport keeps cookie and sensitive PATCH outside Test parameters", async ({ request }) => {
  const filename = process.env.PAPERCLIP_OFFLINE_API_CANARY_INPUT;
  if (!filename) throw new Error("Explicit private offline canary input is required");
  const { cookie, credential } = JSON.parse(await readFile(filename, "utf8")) as { cookie: string; credential: string };
  let authorized = false;
  const server = createServer(async (req, res) => {
    authorized = req.headers.cookie === cookie;
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ publicValue: "observed raw JSON" })); return; }
    for await (const _chunk of req) { /* Drain private synthetic request bytes without diagnostics. */ }
    res.writeHead(409, { "content-type": "text/plain" }).end(credential);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Owned synthetic API did not bind");
  const previousPort = process.env.PAPERCLIP_RUNNER_E2E_PORT;
  try {
    process.env.PAPERCLIP_RUNNER_E2E_PORT = String(address.port);
    const api = new RunnerApi(request); api.setBrowserSession(cookie);
    await expect(api.get("/api/fixture?value=public")).resolves.toEqual({ publicValue: "observed raw JSON" });
    expect(authorized).toBe(true);
    // The deliberate public409 tests real failed report instrumentation while
    // its private body and cookie never enter an APIRequestContext step.
    await api.patchSensitive("/api/fixture", { privateCredential: credential });
  } finally {
    if (previousPort === undefined) delete process.env.PAPERCLIP_RUNNER_E2E_PORT; else process.env.PAPERCLIP_RUNNER_E2E_PORT = previousPort;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
