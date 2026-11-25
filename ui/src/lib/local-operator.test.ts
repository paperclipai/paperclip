// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureLocalOperatorToken,
  installLocalOperatorFetch,
  localOperatorToken,
  withLocalOperatorSocketToken,
} from "./local-operator";

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("local operator sign-in in the board page", () => {
  it("keeps the sign-in token and removes it from the address bar", () => {
    window.history.replaceState(null, "", "/issues?x=1#paperclip-local-operator=v1.token");
    captureLocalOperatorToken();
    expect(localOperatorToken()).toBe("v1.token");
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe("/issues?x=1");
  });

  it("sends the token only on the board's own requests", async () => {
    window.localStorage.setItem("paperclip.localOperatorToken", "v1.token");
    const calls: Array<{ url: string; header: string | null }> = [];
    const target = {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), header: new Headers(init?.headers).get("x-paperclip-local-operator") });
        return new Response("{}");
      }),
    } as unknown as typeof globalThis;
    installLocalOperatorFetch(target);
    await target.fetch("/api/health");
    await target.fetch("https://example.com/api/health");
    expect(calls).toEqual([
      { url: "/api/health", header: "v1.token" },
      { url: "https://example.com/api/health", header: null },
    ]);
  });

  it("adds the token to the board's own live-events socket only", () => {
    window.localStorage.setItem("paperclip.localOperatorToken", "v1.token");
    const own = new URL(withLocalOperatorSocketToken(`ws://${window.location.host}/api/companies/c/events/ws`));
    expect(own.searchParams.get("operator")).toBe("v1.token");
    expect(withLocalOperatorSocketToken("ws://elsewhere.test/ws")).toBe("ws://elsewhere.test/ws");
  });
});

describe("a board opened on a wildcard address", () => {
  it("still adds the token to its live-events socket", () => {
    window.localStorage.setItem("paperclip.localOperatorToken", "v1.token");
    vi.stubGlobal("location", { ...window.location, host: "0.0.0.0:3100", hostname: "0.0.0.0", port: "3100", href: "http://0.0.0.0:3100/", protocol: "http:" });
    try {
      const url = new URL(withLocalOperatorSocketToken("ws://localhost:3100/api/companies/c/events/ws"));
      expect(url.searchParams.get("operator")).toBe("v1.token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
