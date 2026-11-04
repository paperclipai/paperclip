import { createServer, request as httpRequest } from "node:http";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHttpLogger } from "../middleware/logger.js";

async function captureAbortedRequest(input: { path: string; method?: string; partialResponse?: boolean; error?: boolean; status?: number }) {
  const logs: Array<Record<string, any>> = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(JSON.parse(chunk.toString()));
      callback();
    },
  });
  const app = express();
  app.use(createHttpLogger(pino(stream)));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  app.use(async (_req, res) => {
    if (input.error) (res as any).err = new Error("Synthetic response failure");
    if (input.status) res.status(input.status);
    if (input.partialResponse) res.write("Partial response");
    started.resolve();
    await release.promise;
    res.end(JSON.stringify({ status: "in_review" }));
    finished.resolve();
  });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test listener");
  let receivedResponse = false;
  const client = httpRequest({ hostname: "127.0.0.1", port: address.port,
    path: input.path, method: input.method ?? "PATCH" }, res => {
    receivedResponse = true;
    if (input.partialResponse) client.destroy();
    res.resume();
  });
  client.on("error", () => undefined);
  try {
    client.end();
    await started.promise;
    if (!input.partialResponse) client.destroy();
    await expect.poll(() => logs.length, { timeout: 3_000 }).toBe(1);
  } finally {
    client.destroy();
    release.resolve();
    await finished.promise;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(logs).toHaveLength(1);
  return { log: logs[0], receivedResponse };
}

describe("HTTP response completion logging", () => {
  it.each(["/api/issues/synthetic-task", "/api/health"])("does not record a successful status before a response for %s", async path => {
    const method = path === "/api/health" ? "GET" : "PATCH";
    const { log, receivedResponse } = await captureAbortedRequest({ path, method });
    expect(receivedResponse).toBe(false);
    expect(log).toMatchObject({ level: 40, msg: `${method} ${path} — request aborted before response`, res: { statusCode: null } });
  });

  it("distinguishes an incomplete response from a completed 200", async () => {
    const { log, receivedResponse } = await captureAbortedRequest({ path: "/api/issues/synthetic-task", partialResponse: true });
    expect(receivedResponse).toBe(true);
    expect(log).toMatchObject({ level: 40, msg: "PATCH /api/issues/synthetic-task — request aborted during response", res: { statusCode: 200 } });
  });

  it.each([{ error: true }, { status: 503 }])("keeps error severity on an aborted response (%j)", async fault => {
    const { log, receivedResponse } = await captureAbortedRequest({ path: "/api/issues/synthetic-task", ...fault });
    expect(receivedResponse).toBe(false);
    expect(log).toMatchObject({ level: 50, msg: "PATCH /api/issues/synthetic-task — request aborted before response", res: { statusCode: null } });
  });

  it.each([false, true])("keeps webhook paths and query values private when a response aborts (error=%s)", async error => {
    const { log } = await captureAbortedRequest({ path: "/api/chat-webhooks/private-path-canary/slack?token=private-token-canary", error });
    expect(log.msg).toBe("PATCH /api/chat-webhooks/:publicId/:provider — request aborted before response");
    expect(JSON.stringify(log)).not.toContain("private-path-canary");
    expect(JSON.stringify(log)).not.toContain("private-token-canary");
  });

  it("keeps completed success responses unchanged", async () => {
    const logs: Array<Record<string, any>> = [];
    const stream = new Writable({ write(chunk, _encoding, callback) {
      logs.push(JSON.parse(chunk.toString()));
      callback();
    } });
    const app = express();
    app.use(createHttpLogger(pino(stream)));
    app.patch("/api/issues/synthetic-task", (_req, res) => res.json({ ok: true }));
    await request(app).patch("/api/issues/synthetic-task").expect(200);
    expect(logs[0]).toMatchObject({ level: 30,
      msg: "PATCH /api/issues/synthetic-task 200", res: { statusCode: 200 } });
    expect(logs[0].res).not.toHaveProperty("responseCompleted");
  });
});
