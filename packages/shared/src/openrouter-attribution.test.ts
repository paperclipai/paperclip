import { describe, expect, it } from "vitest";
import { isOpenRouterUrl, openRouterAttributionHeaders, openRouterClaudeHeaders } from "./openrouter-attribution.js";

describe("OpenRouter attribution", () => {
  it.each(["https://openrouter.ai/api", "https://openrouter.ai/api/v1", "https://OPENROUTER.ai/api/alpha/decisions", "https://eu.openrouter.ai/api/v1", "https://us.openrouter.ai/api/v1"])("recognizes %s", url => {
    expect(isOpenRouterUrl(url)).toBe(true);
  });
  it.each([undefined, "", "openrouter.ai", "http://openrouter.ai/api", "https://openrouter.ai.evil.test", "https://unknown.openrouter.ai/api/v1", "https://evil.test/openrouter.ai", "https://openrouter.ai@evil.test", "https://user:secret@openrouter.ai/api", "https://api.anthropic.com"])("does not attribute other or malformed destinations: %s", url => {
    expect(isOpenRouterUrl(url)).toBe(false);
  });
  it("replaces mixed-case harness identity without changing credentials, routing, or privacy preferences", () => {
    const existing = { "http-referer": "https://harness.example", "x-TITLE": "Harness", "X-openrouter-title": "Harness", Authorization: "Bearer fixture", "X-Route": "custom", "X-OpenRouter-App-Visibility": "hidden" };
    const result = openRouterAttributionHeaders(existing);
    expect(new Headers(result).get("http-referer")).toBe("https://paperclip.ing");
    expect(new Headers(result).get("x-title")).toBe("Paperclip");
    expect(new Headers(result).get("x-openrouter-title")).toBe("Paperclip");
    expect(result).toMatchObject({ Authorization: "Bearer fixture", "X-Route": "custom", "X-OpenRouter-App-Visibility": "hidden" });
    expect(existing["http-referer"]).toBe("https://harness.example");
  });
  it("merges Claude's newline format without splitting colon-bearing values", () => {
    const result = openRouterClaudeHeaders("http-referer: https://harness.example\r\nAuthorization: Bearer fixture\nX-Route: https://gateway.example:443/path");
    expect(result).toContain("HTTP-Referer: https://paperclip.ing");
    expect(result).not.toContain("harness.example");
    expect(result).toContain("Authorization: Bearer fixture");
    expect(result).toContain("X-Route: https://gateway.example:443/path");
  });
});
