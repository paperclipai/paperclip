import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ghFetch } from "./github-fetch.js";

// A server that accepts the connection and the request, then never writes a
// response. `fetch` has no default timeout, so without a bound in ghFetch the
// request never settles.
let hungServer: http.Server;
let hungUrl: string;

// A server that answers immediately, to confirm the timeout does not disturb
// the normal path.
let okServer: http.Server;
let okUrl: string;

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
});

afterAll(async () => {
  await close(hungServer);
  await close(okServer);
});

afterEach(() => {
  delete process.env.PAPERCLIP_GITHUB_REQUEST_TIMEOUT_MS;
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
