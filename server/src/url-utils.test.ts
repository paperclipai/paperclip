import { describe, expect, it } from "vitest";
import { isLoopbackHost, rewriteLoopbackUrlPort, rewriteUrlPort } from "./url-utils.js";

describe("rewriteUrlPort", () => {
  it("rewrites the port for any explicit-port URL, including external hosts", () => {
    expect(rewriteUrlPort("http://localhost:5678", 3101)).toBe("http://localhost:3101/");
    expect(rewriteUrlPort("http://127.0.0.1:9999", 3101)).toBe("http://127.0.0.1:3101/");
    // A worktree advertises its own port even on a non-loopback host.
    expect(rewriteUrlPort("http://my-host.ts.net:3100", 3103)).toBe("http://my-host.ts.net:3103/");
  });

  it("leaves URLs without an explicit port stable", () => {
    expect(rewriteUrlPort("https://paperclip.example", 3101)).toBe("https://paperclip.example");
    expect(rewriteUrlPort("http://localhost", 3101)).toBe("http://localhost");
  });

  it("passes through empty and unparseable inputs", () => {
    expect(rewriteUrlPort(undefined, 3101)).toBeUndefined();
    expect(rewriteUrlPort("", 3101)).toBeUndefined();
    expect(rewriteUrlPort("not a url", 3101)).toBe("not a url");
  });
});

describe("rewriteLoopbackUrlPort", () => {
  it("rewrites the port for loopback base URLs", () => {
    expect(rewriteLoopbackUrlPort("http://localhost:5678", 3101)).toBe("http://localhost:3101/");
    expect(rewriteLoopbackUrlPort("http://127.0.0.1:9999", 3101)).toBe("http://127.0.0.1:3101/");
    expect(rewriteLoopbackUrlPort("http://[::1]:9999", 3101)).toBe("http://[::1]:3101/");
  });

  it("leaves explicit external base URLs untouched (BRO-1558)", () => {
    // A Tailscale Serve listener on :8443 must survive; rewriting its port to the internal
    // listen port produced an unreachable URL that leaked to agents as a dead PAPERCLIP_API_URL.
    const serve = "https://erics-mac-studio-1.tailc54c7.ts.net:8443";
    expect(rewriteLoopbackUrlPort(serve, 3101)).toBe(serve);
  });

  it("leaves URLs without an explicit port stable", () => {
    expect(rewriteLoopbackUrlPort("https://paperclip.example.com", 3101)).toBe(
      "https://paperclip.example.com",
    );
    expect(rewriteLoopbackUrlPort("http://localhost", 3101)).toBe("http://localhost");
  });

  it("passes through empty and unparseable inputs", () => {
    expect(rewriteLoopbackUrlPort(undefined, 3101)).toBeUndefined();
    expect(rewriteLoopbackUrlPort("", 3101)).toBeUndefined();
    expect(rewriteLoopbackUrlPort("not a url", 3101)).toBe("not a url");
  });
});

describe("isLoopbackHost", () => {
  it("matches loopback hosts including bracketed IPv6", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  it("rejects external hosts", () => {
    expect(isLoopbackHost("erics-mac-studio-1.tailc54c7.ts.net")).toBe(false);
    expect(isLoopbackHost("paperclip.example.com")).toBe(false);
  });
});
