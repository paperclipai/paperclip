import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ghFetch,
  readGitHubResponseBytes,
  readGitHubResponseJson,
  readGitHubResponseText,
} from "./github-fetch.js";

// A server that accepts the connection and the request, then never writes a
// response. `fetch` has no default timeout, so without a bound in ghFetch the
// request never settles.
let hungServer: http.Server;
let hungUrl: string;

// A server that answers immediately, to confirm the timeout does not disturb
// the normal path.
let okServer: http.Server;
let okUrl: string;

let jsonServer: http.Server;
let jsonUrl: string;

// Answers with an accurate content-length larger than the test limit, so the
// declared-size check can refuse it before reading the body.
let sizedServer: http.Server;
let sizedUrl: string;

// Streams chunked output with no content-length until the client disconnects.
// Only the running byte total can stop a read from this server.
let floodServer: http.Server;
let floodUrl: string;

// Sends headers and one chunk, then stops writing without ending the response.
let stalledBodyServer: http.Server;
let stalledBodyUrl: string;

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/`);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

beforeAll(async () => {
  hungServer = http.createServer(() => {});
  hungUrl = await listen(hungServer);
  okServer = http.createServer((_req, res) => res.end("ok"));
  okUrl = await listen(okServer);
  jsonServer = http.createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  jsonUrl = await listen(jsonServer);
  sizedServer = http.createServer((_req, res) => res.end(Buffer.alloc(1000, 0x61)));
  sizedUrl = await listen(sizedServer);
  floodServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let stopped = false;
    const stop = () => { stopped = true; };
    res.on("close", stop);
    res.on("error", stop);
    const pump = () => {
      if (stopped || res.writableEnded) return;
      if (!res.write(chunk)) {
        res.once("drain", pump);
        return;
      }
      setImmediate(pump);
    };
    pump();
  });
  floodUrl = await listen(floodServer);
  stalledBodyServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    // Deliberately never end the response.
  });
  stalledBodyUrl = await listen(stalledBodyServer);
});

afterAll(async () => {
  await close(hungServer);
  await close(okServer);
  await close(jsonServer);
  await close(sizedServer);
  await close(floodServer);
  await close(stalledBodyServer);
});

afterEach(() => {
  delete process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS;
  delete process.env.PAPERCLIP_GITHUB_MAX_RESPONSE_BYTES;
});

describe("ghFetch", () => {
  it("gives up on a host that accepts the connection but never responds", async () => {
    process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS = "250";

    const startedAt = Date.now();
    await expect(ghFetch(hungUrl)).rejects.toThrow(/Could not connect to 127\.0\.0\.1/);
    // The point of the test: the call ends on its own instead of hanging.
    // Generous headroom over the 250ms bound so this asserts "bounded", not a
    // specific scheduling latency.
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });

  it("still returns a response when the host answers", async () => {
    process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS = "5000";

    const response = await ghFetch(okUrl);

    expect(response.ok).toBe(true);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("reads a normal body through the capped readers", async () => {
    process.env.PAPERCLIP_GITHUB_MAX_RESPONSE_BYTES = "1048576";

    await expect(readGitHubResponseText(await ghFetch(okUrl), okUrl)).resolves.toBe("ok");
    await expect(readGitHubResponseBytes(await ghFetch(okUrl), okUrl)).resolves.toEqual(Buffer.from("ok"));
    await expect(readGitHubResponseJson(await ghFetch(jsonUrl), jsonUrl)).resolves.toEqual({ ok: true });
  });

  it("rejects a body whose declared content-length exceeds the limit", async () => {
    process.env.PAPERCLIP_GITHUB_MAX_RESPONSE_BYTES = "100";

    // 1000 bytes with an accurate content-length: refused before the body is read.
    await expect(
      readGitHubResponseBytes(await ghFetch(sizedUrl), sizedUrl),
    ).rejects.toThrow(/exceeds the 100 byte limit/);
  });

  it("stops a body that streams past the limit without declaring a content-length", async () => {
    process.env.PAPERCLIP_GITHUB_MAX_RESPONSE_BYTES = "100";

    // The chunked server streams until the client disconnects, so nothing but
    // the running total can stop this read.
    await expect(
      readGitHubResponseBytes(await ghFetch(floodUrl), floodUrl),
    ).rejects.toThrow(/exceeds the 100 byte limit/);
  });

  it("reports a mid-body stall as a connection error, not a raw abort", async () => {
    // ghFetch resolves once headers arrive, so this timeout fires during the
    // body read — outside ghFetch's own try/catch.
    process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS = "300";
    process.env.PAPERCLIP_GITHUB_MAX_RESPONSE_BYTES = "1048576";

    const response = await ghFetch(stalledBodyUrl);
    expect(response.ok).toBe(true);

    await expect(readGitHubResponseText(response, stalledBodyUrl)).rejects.toThrow(
      /Could not read the response from 127\.0\.0\.1/,
    );
  });

  it("honors a caller-supplied abort signal", async () => {
    // Long request timeout, so only the caller's signal can end this call.
    process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS = "60000";

    const startedAt = Date.now();
    await expect(
      ghFetch(hungUrl, { signal: AbortSignal.timeout(250) }),
    ).rejects.toThrow(/Could not connect to 127\.0\.0\.1/);
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});
