import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  listenViteHmrServer,
  resolveViteHmrHost,
  resolveViteHmrPort,
  resolveViteHmrProtocol,
} from "../app.ts";

describe("resolveViteHmrPort", () => {
  it("uses serverPort + 10000 when the result stays in range", () => {
    expect(resolveViteHmrPort(3100)).toBe(13_100);
    expect(resolveViteHmrPort(55_535)).toBe(65_535);
  });

  it("falls back below the server port when adding 10000 would overflow", () => {
    expect(resolveViteHmrPort(55_536)).toBe(45_536);
    expect(resolveViteHmrPort(63_000)).toBe(53_000);
  });

  it("never returns a privileged or invalid port", () => {
    expect(resolveViteHmrPort(65_535)).toBe(55_535);
    expect(resolveViteHmrPort(9_000)).toBe(19_000);
  });
});

describe("resolveViteHmrHost", () => {
  it("omits local bind hosts so Vite uses the browser hostname", () => {
    expect(resolveViteHmrHost("0.0.0.0")).toBeUndefined();
    expect(resolveViteHmrHost("::")).toBeUndefined();
    expect(resolveViteHmrHost("127.0.0.1")).toBeUndefined();
    expect(resolveViteHmrHost("::1")).toBeUndefined();
    expect(resolveViteHmrHost("LOCALHOST")).toBeUndefined();
  });

  it("keeps externally reachable bind hosts", () => {
    expect(resolveViteHmrHost("paperclip-dev")).toBe("paperclip-dev");
  });
});

describe("resolveViteHmrProtocol", () => {
  it("accepts supported websocket protocols", () => {
    expect(resolveViteHmrProtocol(undefined)).toBeUndefined();
    expect(resolveViteHmrProtocol("ws")).toBe("ws");
    expect(resolveViteHmrProtocol("wss")).toBe("wss");
  });

  it("rejects unsupported protocols", () => {
    expect(() => resolveViteHmrProtocol("http")).toThrow(
      "PAPERCLIP_VITE_HMR_PROTOCOL must be ws or wss",
    );
  });
});

describe("listenViteHmrServer", () => {
  it("binds the HMR listener to the requested host", async () => {
    const server = createServer();

    try {
      await listenViteHmrServer(server, 0, "127.0.0.1");
      const address = server.address();

      expect(server.listening).toBe(true);
      expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  });
});
