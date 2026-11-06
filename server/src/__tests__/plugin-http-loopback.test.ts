import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  executePinnedHttpRequest,
  pluginHttpLoopbackOrigins,
  validateAndResolveFetchUrl,
} from "../services/plugin-host-services.js";

describe("plugin HTTP loopback origins", () => {
  it("parses only exact loopback HTTP(S) origins", () => {
    expect([...pluginHttpLoopbackOrigins([
      "http://127.0.0.1:8795",
      "HTTPS://LOCALHOST:443/",
      "http://127.0.0.1:8795/path",
      "http://user:pass@127.0.0.1:8795",
      "http://10.0.0.1:8795",
      "http://169.254.169.254",
      "https://example.com",
    ].join(","))]).toEqual(["http://127.0.0.1:8795", "https://localhost"]);
  });

  it("keeps private destinations blocked by default", async () => {
    await expect(validateAndResolveFetchUrl("http://127.0.0.1:8795/write", new Set()))
      .rejects.toThrow("private/reserved ranges");
  });

  it("pins only an exact allowed loopback origin", async () => {
    const allowed = pluginHttpLoopbackOrigins("http://127.0.0.1:8795");
    const target = await validateAndResolveFetchUrl("http://127.0.0.1:8795/write", allowed);
    expect(target.resolvedAddress).toBe("127.0.0.1");
    await expect(validateAndResolveFetchUrl("http://127.0.0.1:8796/write", allowed))
      .rejects.toThrow("private/reserved ranges");
  });

  it("uses the operator setting in the host validation path", async () => {
    vi.stubEnv("PAPERCLIP_PLUGIN_HTTP_LOOPBACK_ORIGINS", "http://127.0.0.1:8795");
    try {
      const target = await validateAndResolveFetchUrl("http://127.0.0.1:8795/write");
      expect(target.resolvedAddress).toBe("127.0.0.1");
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects a public DNS answer for an allowed localhost origin", async () => {
    const allowed = pluginHttpLoopbackOrigins("http://localhost:8795");
    await expect(validateAndResolveFetchUrl("http://localhost:8795/write", allowed,
      async () => [{ address: "93.184.216.34", family: 4 }]))
      .rejects.toThrow("private/reserved ranges");
  });

  it("pins the loopback answer when localhost has mixed DNS answers", async () => {
    const allowed = pluginHttpLoopbackOrigins("http://localhost:8795");
    const target = await validateAndResolveFetchUrl("http://localhost:8795/write", allowed,
      async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    expect(target.resolvedAddress).toBe("127.0.0.1");
  });

  it("allows only the listed IPv6 loopback origin", async () => {
    const allowed = pluginHttpLoopbackOrigins("http://[::1]:8795");
    const loopback = async () => [{ address: "::1", family: 6 }];
    const target = await validateAndResolveFetchUrl("http://[::1]:8795/write", allowed, loopback);
    expect(target.resolvedAddress).toBe("::1");
    await expect(validateAndResolveFetchUrl("http://[::1]:8796/write", allowed, loopback))
      .rejects.toThrow("private/reserved ranges");
  });

  it("never opts private networks or metadata addresses into plugin HTTP", async () => {
    const allowed = new Set(["http://10.0.0.1:8795", "http://169.254.169.254"]);
    await expect(validateAndResolveFetchUrl("http://10.0.0.1:8795/", allowed))
      .rejects.toThrow("private/reserved ranges");
    await expect(validateAndResolveFetchUrl("http://169.254.169.254/", allowed))
      .rejects.toThrow("private/reserved ranges");
  });

  it("does not forward credentials to a redirect target", async () => {
    let redirectedRequests = 0;
    const destination = createServer((_request, response) => {
      redirectedRequests++;
      response.end("unexpected request");
    });
    const source = createServer((_request, response) => {
      const destinationAddress = destination.address();
      if (!destinationAddress || typeof destinationAddress === "string") throw new Error("destination port missing");
      response.writeHead(302, { location: `http://127.0.0.1:${destinationAddress.port}/leak` }).end();
    });
    const listen = (server: typeof source) => new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("port missing");
        resolve(address.port);
      });
    });
    try {
      await listen(destination);
      const port = await listen(source);
      const target = await validateAndResolveFetchUrl(`http://127.0.0.1:${port}/write`,
        pluginHttpLoopbackOrigins(`http://127.0.0.1:${port}`));
      const response = await executePinnedHttpRequest(target,
        { headers: { authorization: "Bearer synthetic-secret" } }, new AbortController().signal);
      expect(response.status).toBe(302);
      expect(redirectedRequests).toBe(0);
    } finally {
      await Promise.all([source, destination].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    }
  });
});
