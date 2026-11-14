import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  BROWSER_USE_PROXY_COUNTRY_CODES,
  BROWSER_USE_TOOLS,
  browserUseProxyCountryCodeSchema,
} from "@paperclipai/shared";
import {
  browserUseClient,
  browserUseCostCap,
  browserUseViewerUrl,
  sanitizeBrowserUse,
  isBrowserUseConnection,
} from "../services/browser-use-client.js";

describe("Browser Use v4 transport", () => {
  it("recognizes only the Cloud connector identity", () => {
    expect(isBrowserUseConnection({ transport: "rest_api", config: { sourceTemplateKey: "browser-use-cloud" } })).toBe(true);
    for (const sourceTemplateKey of ["browser-use", "browser-use-native", "another-browser"]) {
      expect(isBrowserUseConnection({ transport: "rest_api", config: { sourceTemplateKey } })).toBe(false);
    }
    expect(isBrowserUseConnection({ transport: "mcp_remote", config: { sourceTemplateKey: "browser-use-cloud" } })).toBe(false);
  });
  it("sends v4 REST with the API key header, never MCP, and never retries paid creates", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.browser-use.com/api/v4/runs");
      expect(new Headers(init.headers).get("X-Browser-Use-API-Key")).toBe(
        "test-key",
      );
      expect(JSON.parse(String(init.body))).toEqual({
        task: "Read example.com",
        browserSettings: { record: false },
        maxCostUsd: 1,
      });
      throw new Error("https://live.browser-use.com/private-token test-key");
    });
    await expect(
      browserUseClient({ "X-Browser-Use-API-Key": "test-key" }, request).start({
        task: "Read example.com",
        browserSettings: { record: false },
        maxCostUsd: 1,
      }),
    ).rejects.toThrow("will not be retried");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("runs the authoritative dispatch gate before sending a paid request", async () => {
    const request = vi.fn();
    const gate = vi.fn(async () => { throw new Error("Budget changed before dispatch"); });
    await expect(browserUseClient({}, request, randomUUID()).start({ task: "Do not dispatch" }, gate))
      .rejects.toThrow("Budget changed before dispatch");
    expect(gate).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
  });
  it("sanitizes nested and serialized credential addresses and sensitive fields", () => {
    const url = "https://live.browser-use.com/watch?token=private";
    const data = {
      liveUrl: url,
      content: [
        {
          text: JSON.stringify({
            nested: url,
            cdpUrl: "wss://connect.browser-use.com/secret",
          }),
        },
      ],
      output: { apiKey: "bu_secret", result: "Useful result" },
    };
    const clean = JSON.stringify(sanitizeBrowserUse(data));
    expect(clean).not.toContain("token=private");
    expect(clean).not.toContain("bu_secret");
    expect(clean).not.toContain("connect.browser-use.com");
    expect(clean).toContain("Useful result");
  });
  it("accepts only the exact HTTPS viewer origin", () => {
    expect(
      browserUseViewerUrl("https://live.browser-use.com/view/123"),
    ).toContain("/view/123");
    for (const value of [
      "not a URL bu_private",
      "http://live.browser-use.com/x",
      "https://live.browser-use.com.evil.test/x",
      "https://evil@live.browser-use.com/x",
      "https://live.browser-use.com:4000/x",
    ])
      expect(() => browserUseViewerUrl(value)).toThrow();
  });
  it("enforces minimum finite caps and conservative action classification", () => {
    expect(browserUseCostCap(null, 9, 2.5)).toBe(2.5);
    expect(browserUseCostCap()).toBeUndefined();
    expect(() => browserUseCostCap(0, 10)).toThrow("budget");
    expect(
      BROWSER_USE_TOOLS.filter((t) => !t.annotations.destructiveHint).map(
        (t) => t.name,
      ),
    ).toEqual(["browser_status", "browser_sessions", "browser_profiles"]);
  });
  it("offers an optional proxy exit country and forwards it as a browser setting", async () => {
    for (const name of ["browser_start", "browser_continue"]) {
      const schema = BROWSER_USE_TOOLS.find((t) => t.name === name)!.inputSchema;
      expect(schema.properties.proxyCountryCode).toMatchObject({
        type: ["string", "null"],
        enum: [...BROWSER_USE_PROXY_COUNTRY_CODES, null],
      });
      expect(schema.required).not.toContain("proxyCountryCode");
    }
    for (const value of ["ch", "de", "us"]) {
      expect(browserUseProxyCountryCodeSchema.safeParse(value).success).toBe(
        true,
      );
      expect(BROWSER_USE_PROXY_COUNTRY_CODES).toContain(value);
    }
    // "zz" and "xx" are unassigned, so they must not reach the provider.
    for (const value of ["zz", "xx", "CH", "che", "c", "", "ch ", "switzerland"])
      expect(browserUseProxyCountryCodeSchema.safeParse(value).success).toBe(
        false,
      );
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(JSON.parse(String(init.body)).browserSettings).toEqual({
        record: false,
        proxyCountryCode: "ch",
      });
      return Response.json({
        id: randomUUID(),
        sessionId: randomUUID(),
        status: "queued",
        model: "browser-use-default",
      });
    });
    await browserUseClient({}, request).start({
      task: "Read example.com",
      browserSettings: { record: false, proxyCountryCode: "ch" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses per-connection Retry-After backoff and suppresses provider error bodies", async () => {
    const request = vi.fn(
      async () =>
        new Response("private error bu_canary", {
          status: 429,
          headers: { "retry-after": "60" },
        }),
    );
    const client = browserUseClient({}, request, randomUUID());
    await expect(client.probe()).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 60000,
    });
    await expect(client.probe()).rejects.toThrow("rate limited");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
