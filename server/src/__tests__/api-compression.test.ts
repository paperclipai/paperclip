import express from "express";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { deflateSync, gunzipSync, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { apiCompression } from "../middleware/api-compression.js";

type RawResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
};

const openServers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  })));
});

function issueListFixture(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `issue-${index}`,
    companyId: "company-1",
    identifier: `PAP-${index + 1}`,
    title: `Synthetic issue list row ${index}`,
    description: "repeatable payload used to prove API compression on the hot issue-list response",
    status: index % 2 === 0 ? "in_progress" : "todo",
    priority: "medium",
    assigneeAgentId: index % 3 === 0 ? "agent-1" : null,
    assigneeUserId: null,
    parentId: null,
    projectId: "project-1",
    goalId: "goal-1",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    successfulRunHandoff: null,
    activeRecoveryAction: null,
  }));
}

async function requestRaw(app: express.Express, path: string, headers: Record<string, string> = {}): Promise<RawResponse> {
  const server = createServer(app);
  openServers.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;

  return await new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      path,
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function buildApp() {
  const app = express();
  app.use("/api", apiCompression());
  app.get("/api/companies/:companyId/issues", (_req, res) => {
    res.json(issueListFixture(500));
  });
  app.get("/api/small", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/encoded", (_req, res) => {
    const body = Buffer.from(JSON.stringify({ already: "encoded" }));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "deflate");
    res.end(deflateSync(body));
  });
  app.get("/api/etag", (_req, res) => {
    res.setHeader("ETag", "\"fixture-etag\"");
    res.json(issueListFixture(500));
  });
  app.get("/api/download", (_req, res) => {
    res.setHeader("Content-Type", "application/octet-stream");
    res.write("chunk-one:");
    res.end("chunk-two");
  });
  app.get("/api/json-download", (_req, res) => {
    const chunk = JSON.stringify(issueListFixture(500));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"issues.json\"");
    res.write(chunk.slice(0, chunk.length / 2));
    res.end(chunk.slice(chunk.length / 2));
  });
  // Mirrors better-call's setResponse (Better Auth sign-in/sign-up): headers
  // are committed with writeHead() first, then the web-stream body arrives as
  // Uint8Array chunks.
  app.get("/api/auth-bridge", (req, res) => {
    const body = JSON.stringify({
      token: "t".repeat(Number(req.query.pad ?? 0)),
      user: { name: "Dotta", email: "dotta@example.test" },
    });
    res.setHeader("content-type", "application/json");
    res.setHeader("set-cookie", "workspace.session_token=abc; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax");
    res.writeHead(200);
    const bytes = new TextEncoder().encode(body);
    res.write(bytes.subarray(0, 16));
    res.write(bytes.subarray(16));
    res.end();
  });
  app.get("/api/uint8-json", (req, res) => {
    const body = JSON.stringify(issueListFixture(Number(req.query.count ?? 1)));
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(new TextEncoder().encode(body));
  });
  return app;
}

describe("API compression middleware", () => {
  it("compresses the hot 500-item issue-list response with gzip when the client supports it", async () => {
    const uncompressed = await requestRaw(buildApp(), "/api/companies/company-1/issues?limit=500");
    const compressed = await requestRaw(buildApp(), "/api/companies/company-1/issues?limit=500", {
      "accept-encoding": "gzip",
    });

    expect(uncompressed.statusCode).toBe(200);
    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers["vary"]).toContain("Accept-Encoding");
    expect(JSON.parse(gunzipSync(compressed.body).toString("utf8"))).toHaveLength(500);
    expect(compressed.body.byteLength).toBeLessThan(uncompressed.body.byteLength / 5);
  });

  it("uses deflate when that is the supported content encoding", async () => {
    const res = await requestRaw(buildApp(), "/api/companies/company-1/issues?limit=500", {
      "accept-encoding": "deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("deflate");
    expect(JSON.parse(inflateSync(res.body).toString("utf8"))).toHaveLength(500);
  });

  it("keeps small JSON responses uncompressed for compatibility", async () => {
    const res = await requestRaw(buildApp(), "/api/small", {
      "accept-encoding": "gzip, deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf8"))).toEqual({ ok: true });
  });

  it("does not double-compress responses that already set Content-Encoding", async () => {
    const res = await requestRaw(buildApp(), "/api/encoded", {
      "accept-encoding": "gzip, deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("deflate");
    expect(JSON.parse(inflateSync(res.body).toString("utf8"))).toEqual({ already: "encoded" });
  });

  it("weakens strong ETag validators on compressed JSON responses", async () => {
    const res = await requestRaw(buildApp(), "/api/etag", {
      "accept-encoding": "gzip",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers.etag).toBe("W/\"fixture-etag\"");
    expect(JSON.parse(gunzipSync(res.body).toString("utf8"))).toHaveLength(500);
  });

  it("passes streamed non-JSON responses through without compression", async () => {
    const res = await requestRaw(buildApp(), "/api/download", {
      "accept-encoding": "gzip, deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString("utf8")).toBe("chunk-one:chunk-two");
  });

  it("passes streamed JSON attachment downloads through without compression", async () => {
    const res = await requestRaw(buildApp(), "/api/json-download", {
      "accept-encoding": "gzip, deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe("attachment; filename=\"issues.json\"");
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf8"))).toHaveLength(500);
  });

  it("delivers small writeHead+Uint8Array auth responses byte-for-byte", async () => {
    const res = await requestRaw(buildApp(), "/api/auth-bridge", {
      "accept-encoding": "gzip, deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(res.body.toString("utf8")).user.email).toBe("dotta@example.test");
  });

  it("does not drop the connection for large writeHead+Uint8Array auth responses", async () => {
    const res = await requestRaw(buildApp(), "/api/auth-bridge?pad=2000", {
      "accept-encoding": "gzip, deflate",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    const parsed = JSON.parse(res.body.toString("utf8"));
    expect(parsed.token).toHaveLength(2000);
    expect(parsed.user.email).toBe("dotta@example.test");
  });

  it("compresses large Uint8Array bodies without corrupting them", async () => {
    const res = await requestRaw(buildApp(), "/api/uint8-json?count=500", {
      "accept-encoding": "gzip",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(gunzipSync(res.body).toString("utf8"))).toHaveLength(500);
  });
});
