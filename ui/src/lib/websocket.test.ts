import { afterEach, describe, expect, it, vi } from "vitest";
import { tryCreateWebSocket } from "./websocket";

afterEach(() => vi.unstubAllGlobals());

describe("tryCreateWebSocket", () => {
  it.each([undefined, {}, () => undefined])("returns null for an unavailable constructor: %s", (value) => {
    vi.stubGlobal("WebSocket", value);
    expect(tryCreateWebSocket("ws://localhost/events")).toBeNull();
  });

  it("returns null when browser policy prevents construction", () => {
    vi.stubGlobal("WebSocket", class {
      constructor() { throw new DOMException("Blocked", "SecurityError"); }
    });
    expect(tryCreateWebSocket("ws://localhost/events")).toBeNull();
  });

  it("uses the current constructor so a later retry can recover", () => {
    vi.stubGlobal("WebSocket", undefined);
    expect(tryCreateWebSocket("ws://localhost/events")).toBeNull();
    class Socket {
      constructor(readonly url: string) {}
    }
    vi.stubGlobal("WebSocket", Socket);
    expect(tryCreateWebSocket("ws://localhost/events")).toEqual(new Socket("ws://localhost/events"));
  });
});
