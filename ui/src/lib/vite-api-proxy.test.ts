import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createApiProxy } from "./vite-api-proxy";

describe("createApiProxy", () => {
  function fireProxyReq(req: {
    headers: Record<string, string | string[] | undefined>;
    socket?: { encrypted?: boolean };
  }) {
    const proxy = createApiProxy();
    const proxyEmitter = new EventEmitter();
    proxy["/api"].configure!(proxyEmitter as never, {} as never);
    const setHeader = vi.fn();
    proxyEmitter.emit("proxyReq", { setHeader }, { socket: {}, ...req });
    return setHeader;
  }

  it("proxies /api to the given target with ws support", () => {
    const proxy = createApiProxy("http://example.local:9999");
    expect(proxy["/api"].target).toBe("http://example.local:9999");
    expect(proxy["/api"].ws).toBe(true);
  });

  it("injects x-forwarded-host and defaults x-forwarded-proto to http on plain sockets", () => {
    const setHeader = fireProxyReq({ headers: { host: "goldie.gerbil-company.ts.net:3101" } });
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-host", "goldie.gerbil-company.ts.net:3101");
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "http");
  });

  it("derives x-forwarded-proto=https when the client socket is TLS", () => {
    const setHeader = fireProxyReq({
      headers: { host: "app.example.com" },
      socket: { encrypted: true },
    });
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "https");
  });

  it("preserves an upstream x-forwarded-proto header from an HTTPS tunnel", () => {
    const setHeader = fireProxyReq({
      headers: { host: "abcd.ngrok.app", "x-forwarded-proto": "https" },
    });
    expect(setHeader).toHaveBeenCalledWith("x-forwarded-proto", "https");
  });

  it("skips forwarding headers when the client sends no Host", () => {
    const setHeader = fireProxyReq({ headers: {} });
    expect(setHeader).not.toHaveBeenCalled();
  });
});
