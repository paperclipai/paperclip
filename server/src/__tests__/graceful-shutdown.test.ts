import { describe, expect, it, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Response } from "express";

import { sseRegistry } from "../services/sse-registry.js";

interface FakeRes extends EventEmitter {
  _written: string[];
  _ended: boolean;
  writable: boolean;
  write: (chunk: string) => boolean;
  end: () => void;
}

function fakeRes(): FakeRes {
  const emitter = new EventEmitter() as FakeRes;
  emitter._written = [];
  emitter._ended = false;
  emitter.writable = true;
  emitter.write = (chunk: string) => {
    emitter._written.push(chunk);
    return true;
  };
  emitter.end = () => {
    emitter._ended = true;
    emitter.writable = false;
  };
  return emitter;
}

describe("sseRegistry", () => {
  beforeEach(async () => {
    // Drain any leftover state between tests
    await sseRegistry.drain({ timeoutMs: 50, reason: "test:reset" });
  });

  it("register adds, unregister removes", () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    expect(sseRegistry.size()).toBe(0);

    sseRegistry.register(r1 as unknown as Response);
    expect(sseRegistry.size()).toBe(1);

    sseRegistry.register(r2 as unknown as Response);
    expect(sseRegistry.size()).toBe(2);

    sseRegistry.unregister(r1 as unknown as Response);
    expect(sseRegistry.size()).toBe(1);

    sseRegistry.unregister(r2 as unknown as Response);
    expect(sseRegistry.size()).toBe(0);
  });

  it("drain emits final shutdown event and calls res.end() on each tracked response", async () => {
    const r1 = fakeRes();
    const r2 = fakeRes();
    sseRegistry.register(r1 as unknown as Response);
    sseRegistry.register(r2 as unknown as Response);

    await sseRegistry.drain({ timeoutMs: 1000, reason: "shutdown:SIGTERM" });

    for (const r of [r1, r2]) {
      expect(r._ended).toBe(true);
      expect(r.writable).toBe(false);
      // Expect exactly one write containing the shutdown event frame
      expect(r._written.length).toBe(1);
      const frame = r._written[0];
      expect(frame).toContain("event: shutdown\n");
      expect(frame).toContain("data: ");
      // Payload should include the reason and a ts ISO timestamp
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const payload = JSON.parse(dataLine!.slice("data: ".length));
      expect(payload.reason).toBe("shutdown:SIGTERM");
      expect(typeof payload.ts).toBe("string");
      expect(() => new Date(payload.ts)).not.toThrow();
    }

    expect(sseRegistry.size()).toBe(0);
  });

  it("drain enforces the timeout when a response wedges", async () => {
    // A wedged response: writable stays true forever and end() does nothing
    const wedged = fakeRes();
    wedged.end = () => {
      // Simulates an end() that never actually closes — writable remains true
    };
    sseRegistry.register(wedged as unknown as Response);

    const start = Date.now();
    await sseRegistry.drain({ timeoutMs: 50, reason: "shutdown:test" });
    const elapsed = Date.now() - start;

    // Should not block forever — bounded by timeout (with reasonable upper bound)
    expect(elapsed).toBeLessThan(500);
    // Final clear should remove the wedged entry
    expect(sseRegistry.size()).toBe(0);
  });
});
