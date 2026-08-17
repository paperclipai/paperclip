import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST,
  DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES,
  SANDBOX_NET_FETCH_BRIDGE_PATH,
  SandboxNetFetchDeniedError,
  createSandboxNetFetchBridgeHandler,
  fetchSandboxNet,
  isPublicSandboxNetFetchAddress,
  isSandboxNetFetchHostAllowed,
  loadSandboxNetFetchAllowlist,
  parseSandboxNetFetchRequest,
  type SandboxNetFetchLogEntry,
} from "./sandbox-net-fetch.js";

const ALLOW = { allowlist: ["api.github.com", "amazon.jobs", "bsky.social"] };

describe("sandbox net-fetch door", () => {
  const cleanupDirs: string[] = [];
  const cleanupServers: Server[] = [];

  afterEach(async () => {
    while (cleanupServers.length > 0) {
      const server = cleanupServers.pop();
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function tempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.push(dir);
    return dir;
  }

  async function startLocalServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
    const server = createServer(handler);
    cleanupServers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    return address.port;
  }

  const loopback = {
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    allowAddress: () => true,
  };

  describe("request validation", () => {
    it("accepts a GET manifest for an allowlisted domain and defaults the method", () => {
      expect(parseSandboxNetFetchRequest('{"url":"https://api.github.com/repos/x"}', ALLOW)).toEqual({
        url: "https://api.github.com/repos/x",
        method: "GET",
        maxBytes: DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES,
      });
    });

    it("is GET-only", () => {
      for (const method of ["POST", "HEAD", "PUT", "DELETE", "get"]) {
        expect(() => parseSandboxNetFetchRequest(JSON.stringify({ url: "https://api.github.com/", method }), ALLOW))
          .toThrow(/only permits GET/);
      }
    });

    it("rejects malformed manifests, non-http(s) schemes, and credential-bearing URLs", () => {
      expect(() => parseSandboxNetFetchRequest("not json", ALLOW)).toThrow(/JSON body/);
      expect(() => parseSandboxNetFetchRequest("[]", ALLOW)).toThrow(/object with a URL/);
      expect(() => parseSandboxNetFetchRequest("{}", ALLOW)).toThrow(/non-empty URL/);
      expect(() => parseSandboxNetFetchRequest('{"url":"file:///etc/passwd"}', ALLOW)).toThrow(/http and https/);
      expect(() => parseSandboxNetFetchRequest('{"url":"ftp://api.github.com/x"}', ALLOW)).toThrow(/http and https/);
      expect(() => parseSandboxNetFetchRequest('{"url":"https://user:pass@api.github.com/"}', ALLOW)).toThrow(/credentials/);
    });

    it("enforces the deny-default domain allowlist with dot-boundary subdomain matching", () => {
      // Exact and subdomain matches pass.
      expect(() => parseSandboxNetFetchRequest('{"url":"https://amazon.jobs/en/search"}', ALLOW)).not.toThrow();
      expect(() => parseSandboxNetFetchRequest('{"url":"https://www.amazon.jobs/en"}', ALLOW)).not.toThrow();
      // Everything else is denied, including suffix tricks.
      for (const url of [
        "https://example.com/",
        "https://evilamazon.jobs.example.com/",
        "https://notbsky.social.evil.example/",
        "https://evilbsky.social/",
        "https://bsky.social.evil.com/",
        "http://203.0.113.9/",
      ]) {
        expect(() => parseSandboxNetFetchRequest(JSON.stringify({ url }), ALLOW), url)
          .toThrow(SandboxNetFetchDeniedError);
      }
    });

    it("lets a request lower the response cap but never raise it", () => {
      expect(parseSandboxNetFetchRequest('{"url":"https://api.github.com/","maxBytes":1024}', ALLOW).maxBytes).toBe(1024);
      expect(
        parseSandboxNetFetchRequest(
          JSON.stringify({ url: "https://api.github.com/", maxBytes: 1024 * 1024 * 64 }),
          ALLOW,
        ).maxBytes,
      ).toBe(DEFAULT_SANDBOX_NET_FETCH_MAX_RESPONSE_BYTES);
      expect(() => parseSandboxNetFetchRequest('{"url":"https://api.github.com/","maxBytes":0}', ALLOW))
        .toThrow(/positive number/);
      expect(() => parseSandboxNetFetchRequest('{"url":"https://api.github.com/","maxBytes":"big"}', ALLOW))
        .toThrow(/positive number/);
    });

    it("matches hostnames case-insensitively and ignores a trailing dot", () => {
      expect(isSandboxNetFetchHostAllowed("API.GITHUB.COM", ALLOW.allowlist)).toBe(true);
      expect(isSandboxNetFetchHostAllowed("api.github.com.", ALLOW.allowlist)).toBe(true);
      expect(isSandboxNetFetchHostAllowed("", ALLOW.allowlist)).toBe(false);
    });

    it("pins the shipped default allowlist", () => {
      expect([...DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST]).toEqual([
        "api.github.com",
        "boards-api.greenhouse.io",
        "api.ashbyhq.com",
        "api.lever.co",
        "amazon.jobs",
        "public.api.bsky.app",
        "bsky.social",
      ]);
    });
  });

  describe("destination address policy", () => {
    it("rejects private, loopback, link-local, and multicast destinations", () => {
      for (const address of [
        "127.0.0.1", "10.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.1.1", "224.0.0.1",
        "100.64.0.1", "0.1.2.3",
        "::1", "::", "fe80::1", "fe90::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:10.0.0.1",
      ]) {
        expect(isPublicSandboxNetFetchAddress(address), address).toBe(false);
      }
      expect(isPublicSandboxNetFetchAddress("203.0.113.20")).toBe(true);
      expect(isPublicSandboxNetFetchAddress("2001:db8::20")).toBe(true);
      expect(isPublicSandboxNetFetchAddress("::ffff:203.0.113.5")).toBe(true);
    });

    it("refuses to fetch when the destination resolves to no public address", async () => {
      await expect(
        fetchSandboxNet(
          { url: "https://api.github.com/", method: "GET", maxBytes: 1024 },
          { resolve: async () => [{ address: "127.0.0.1", family: 4 }] },
        ),
      ).rejects.toThrow(/public address/);
    });
  });

  describe("allowlist config file", () => {
    it("returns the built-in defaults when the config file is absent", async () => {
      const dir = await tempDir("net-fetch-config-");
      const loaded = await loadSandboxNetFetchAllowlist({ configFile: path.join(dir, "missing.json") });
      expect(loaded.allowlist).toEqual([...DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST]);
      expect(loaded.warnings).toEqual([]);
    });

    it("adds global and matching per-company domains, never another company's", async () => {
      const dir = await tempDir("net-fetch-config-");
      const configFile = path.join(dir, "net-fetch-allowlist.json");
      await writeFile(configFile, JSON.stringify({
        allowlist: ["api.example.org"],
        companies: { "co-a": ["a-only.example"], "co-b": ["b-only.example"] },
      }), "utf8");
      const loaded = await loadSandboxNetFetchAllowlist({ configFile, companyId: "co-a" });
      expect(loaded.allowlist).toContain("api.example.org");
      expect(loaded.allowlist).toContain("a-only.example");
      expect(loaded.allowlist).not.toContain("b-only.example");
      expect(loaded.allowlist).toEqual(expect.arrayContaining([...DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST]));
      expect(loaded.warnings).toEqual([]);
    });

    it("falls back to the defaults (never wider) on a malformed config, with warnings", async () => {
      const dir = await tempDir("net-fetch-config-");
      const configFile = path.join(dir, "net-fetch-allowlist.json");
      await writeFile(configFile, "{ not json", "utf8");
      const malformed = await loadSandboxNetFetchAllowlist({ configFile });
      expect(malformed.allowlist).toEqual([...DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST]);
      expect(malformed.warnings.join("\n")).toMatch(/malformed/);

      await writeFile(configFile, JSON.stringify({ allowlist: "api.example.org", companies: [] }), "utf8");
      const wrongShapes = await loadSandboxNetFetchAllowlist({ configFile, companyId: "co-a" });
      expect(wrongShapes.allowlist).toEqual([...DEFAULT_SANDBOX_NET_FETCH_DOMAIN_ALLOWLIST]);
      expect(wrongShapes.warnings.length).toBe(2);
    });
  });

  describe("bounded fetch execution", () => {
    it("fetches an allowlisted target pinned to the resolved address and reports bytes", async () => {
      const port = await startLocalServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url }));
      });
      const result = await fetchSandboxNet(
        { url: `http://localhost:${port}/feed.json`, method: "GET", maxBytes: 64 * 1024 },
        loopback,
      );
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true, path: "/feed.json" });
      expect(result.bytes).toBe(Buffer.byteLength(result.body));
      expect(result.headers["content-type"]).toBe("application/json");
    });

    it("enforces the response size cap", async () => {
      const port = await startLocalServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(4096));
      });
      await expect(
        fetchSandboxNet({ url: `http://localhost:${port}/big`, method: "GET", maxBytes: 1024 }, loopback),
      ).rejects.toThrow(/exceeded 1024 bytes/);
    });

    it("returns redirects instead of following them", async () => {
      const port = await startLocalServer((_req, res) => {
        res.writeHead(302, { location: "http://localhost/should-not-be-followed" });
        res.end();
      });
      const result = await fetchSandboxNet(
        { url: `http://localhost:${port}/moved`, method: "GET", maxBytes: 1024 },
        loopback,
      );
      expect(result.status).toBe(302);
      expect(result.headers.location).toBe("http://localhost/should-not-be-followed");
    });
  });

  describe("bridge handler", () => {
    async function readLogEntries(logFile: string): Promise<SandboxNetFetchLogEntry[]> {
      const raw = await readFile(logFile, "utf8");
      return raw.trim().split("\n").map((line) => JSON.parse(line) as SandboxNetFetchLogEntry);
    }

    it("routes only POSTs to the door path", () => {
      const handler = createSandboxNetFetchBridgeHandler({ allowlist: ALLOW.allowlist, logFile: "/dev/null" });
      expect(handler.matches({ method: "POST", path: SANDBOX_NET_FETCH_BRIDGE_PATH })).toBe(true);
      expect(handler.matches({ method: "GET", path: SANDBOX_NET_FETCH_BRIDGE_PATH })).toBe(false);
      expect(handler.matches({ method: "POST", path: "/api/agents/me" })).toBe(false);
    });

    it("serves an allowed fetch and logs url, status, and bytes company-scoped", async () => {
      const dir = await tempDir("net-fetch-log-");
      const logFile = path.join(dir, "net-fetch.jsonl");
      const port = await startLocalServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      const handler = createSandboxNetFetchBridgeHandler({
        allowlist: ["localhost"],
        companyId: "co-test",
        runId: "run-1",
        logFile,
        ...loopback,
      });
      const response = await handler.handle({
        id: "req-1",
        method: "POST",
        path: SANDBOX_NET_FETCH_BRIDGE_PATH,
        query: "",
        headers: {},
        body: JSON.stringify({ url: `http://localhost:${port}/x` }),
        createdAt: new Date().toISOString(),
      });
      expect(response.status).toBe(200);
      const envelope = JSON.parse(response.body) as { status: number; body: string; bytes: number };
      expect(envelope.status).toBe(200);
      expect(envelope.body).toBe('{"ok":true}');
      expect(envelope.bytes).toBe(11);

      const entries = await readLogEntries(logFile);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        runId: "run-1",
        companyId: "co-test",
        url: `http://localhost:${port}/x`,
        method: "GET",
        outcome: "ok",
        status: 200,
        bytes: 11,
      });
    });

    it("answers 403 for allowlist denials and 400 for malformed manifests, logging both", async () => {
      const dir = await tempDir("net-fetch-log-");
      const logFile = path.join(dir, "net-fetch.jsonl");
      const handler = createSandboxNetFetchBridgeHandler({ allowlist: ALLOW.allowlist, logFile });
      const base = {
        id: "req-1",
        query: "",
        headers: {},
        method: "POST",
        path: SANDBOX_NET_FETCH_BRIDGE_PATH,
        createdAt: new Date().toISOString(),
      };
      const denied = await handler.handle({ ...base, body: '{"url":"https://example.com/"}' });
      expect(denied.status).toBe(403);
      expect(JSON.parse(denied.body).error).toMatch(/allowlist/);

      const rejected = await handler.handle({ ...base, body: '{"url":"https://api.github.com/","method":"POST"}' });
      expect(rejected.status).toBe(400);
      expect(JSON.parse(rejected.body).error).toMatch(/only permits GET/);

      const entries = await readLogEntries(logFile);
      expect(entries.map((entry) => entry.outcome)).toEqual(["denied", "rejected"]);
      expect(entries[0]?.url).toBe("https://example.com/");
    });

    it("answers 502 when the upstream fetch fails, and logs the error", async () => {
      const dir = await tempDir("net-fetch-log-");
      const logFile = path.join(dir, "net-fetch.jsonl");
      const handler = createSandboxNetFetchBridgeHandler({
        allowlist: ["localhost"],
        logFile,
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
        // Default public-address policy stays on: loopback is refused.
      });
      const response = await handler.handle({
        id: "req-1",
        method: "POST",
        path: SANDBOX_NET_FETCH_BRIDGE_PATH,
        query: "",
        headers: {},
        body: '{"url":"http://localhost:9/x"}',
        createdAt: new Date().toISOString(),
      });
      expect(response.status).toBe(502);
      expect(JSON.parse(response.body).error).toMatch(/public address/);
      const entries = await readLogEntries(logFile);
      expect(entries[0]).toMatchObject({ outcome: "error", status: null });
    });

    it("sizes the worker envelope above the raw cap so a max-size body fits after JSON escaping", () => {
      const handler = createSandboxNetFetchBridgeHandler({
        allowlist: ALLOW.allowlist,
        logFile: "/dev/null",
        maxResponseBytes: 1024,
      });
      expect(handler.envelopeMaxBytes).toBeGreaterThan(1024 * 6);
    });
  });
});
