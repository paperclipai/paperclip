import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { BROWSER_USE_TOOLS } from "@paperclipai/shared";
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
