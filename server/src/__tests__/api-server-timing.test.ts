import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { apiServerTiming } from "../middleware/api-server-timing.js";

const openServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  })));
});

async function serve(app: express.Express) {
  const server = createServer(app);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("apiServerTiming", () => {
  it("reports the server time for a JSON response, including time spent before the handler", async () => {
    const app = express();
    app.use("/api", apiServerTiming());
    app.use("/api", (_req, _res, next) => setTimeout(next, 25));
    app.get("/api/thing", (_req, res) => res.json({ ok: true }));
    const response = await fetch(`${await serve(app)}/api/thing`);

    expect(response.status).toBe(200);
    const match = /^paperclip_api;dur=(\d+(?:\.\d+)?)$/.exec(response.headers.get("server-timing") ?? "");
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(20);
  });

  it("keeps route-specific phases and appends the total after them", async () => {
    const app = express();
    app.use("/api", apiServerTiming());
    app.get("/api/issue", (_req, res) => {
      res.setHeader("Server-Timing", "paperclip_issue;dur=3.0, issue_lookup;dur=1.0");
      res.status(204).end();
    });
    const response = await fetch(`${await serve(app)}/api/issue`);

    expect(response.headers.get("server-timing")).toMatch(
      /^paperclip_issue;dur=3\.0, issue_lookup;dur=1\.0, paperclip_api;dur=\d+(\.\d+)?$/,
    );
  });

  it("times responses with explicit writeHead calls and errors once", async () => {
    const app = express();
    app.use("/api", apiServerTiming());
    app.get("/api/raw", (_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
    });
    const response = await fetch(`${await serve(app)}/api/raw`);

    expect(response.status).toBe(404);
    expect(response.headers.get("server-timing")?.match(/paperclip_api/g)).toHaveLength(1);
  });
});
