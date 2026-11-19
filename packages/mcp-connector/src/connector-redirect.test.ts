import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectorClient } from "./connector.js";
import { loadConnectorConfig } from "./config.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("connector credential transport", () => {
  it("does not follow redirects when enrolling or rotating credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "connector-redirect-"));
    dirs.push(dir);
    const config = loadConnectorConfig({ env: {
      PAPERCLIP_URL: "https://paperclip.example.com",
      PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN: "token",
      PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE: join(dir, "credentials.json"),
      PAPERCLIP_MCP_CONNECTOR_UPSTREAMS: "demo=http://127.0.0.1/mcp",
    } });
    const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
    const doFetch = vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({ url: url.toString(), redirect: init.redirect });
      return Response.json({ connectorId: "c1", companyId: "company", credential: "secret" });
    }) as unknown as typeof fetch;
    const client = new McpConnectorClient({ config, fetch: doFetch, logger: () => undefined });
    await client.ensureCredentials();
    await client.rotateCredential();
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.redirect)).toEqual(["error", "error"]);
  });

  it("waits for Retry-After when enrollment is rate limited", async () => {
    vi.useFakeTimers();
    try {
      const dir = mkdtempSync(join(tmpdir(), "connector-enroll-429-"));
      dirs.push(dir);
      const config = loadConnectorConfig({ env: {
        PAPERCLIP_URL: "https://paperclip.example.com",
        PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN: "token",
        PAPERCLIP_MCP_CONNECTOR_CREDENTIALS_FILE: join(dir, "credentials.json"),
        PAPERCLIP_MCP_CONNECTOR_UPSTREAMS: "demo=http://127.0.0.1/mcp",
      } });
      const doFetch = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "7" } }))
        .mockResolvedValueOnce(Response.json({ connectorId: "c1", companyId: "company", credential: "secret" })) as unknown as typeof fetch;
      const client = new McpConnectorClient({ config, fetch: doFetch, logger: () => undefined });
      const enrolled = client.ensureCredentials();
      await vi.advanceTimersByTimeAsync(6_999);
      expect(doFetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(enrolled).resolves.toMatchObject({ connectorId: "c1" });
      expect(doFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
