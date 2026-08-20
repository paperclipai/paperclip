import { describe, it, expect } from "vitest";
import {
  computePaperclipRunEventKey,
  computePayloadHash,
  computeSourceEventId,
  stableStringify,
} from "./index.js";

describe("JAC-4532: event identity utilities", () => {
  describe("stableStringify", () => {
    it("produces deterministic output for same content with different key order", () => {
      const a = { runId: "abc", tokens: 100, provider: "openai" };
      const b = { provider: "openai", runId: "abc", tokens: 100 };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });

    it("handles nested objects and arrays", () => {
      const a = { z: 1, a: { y: 2, x: 3 } };
      const b = { a: { x: 3, y: 2 }, z: 1 };
      expect(stableStringify(a)).toBe(stableStringify(b));
    });
  });

  describe("computePayloadHash", () => {
    it("produces a 64-char hex SHA-256 digest", () => {
      const hash = computePayloadHash({ a: 1, b: 2 });
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("is deterministic regardless of key insertion order", () => {
      const h1 = computePayloadHash({ a: 1, b: 2 });
      const h2 = computePayloadHash({ b: 2, a: 1 });
      expect(h1).toBe(h2);
    });
  });

  describe("computePaperclipRunEventKey", () => {
    it("produces key in paperclip:<run_id>:<usage_updated_at>:<payload_hash> format", () => {
      const key = computePaperclipRunEventKey({
        runId: "run-123",
        usageUpdatedAt: "2026-08-04T20:00:00Z",
        payloadHash: "abc123",
      });
      expect(key).toBe("paperclip:run-123:2026-08-04T20:00:00Z:abc123");
    });

    it("is deterministic for same inputs", () => {
      const params = { runId: "r1", usageUpdatedAt: "2026-01-01T00:00:00Z", payloadHash: "deadbeef" };
      expect(computePaperclipRunEventKey(params)).toBe(computePaperclipRunEventKey(params));
    });
  });

  describe("computeSourceEventId", () => {
    it("produces key in paperclip:<run_id>:<usage_updated_at> format", () => {
      const sid = computeSourceEventId({
        runId: "run-456",
        usageUpdatedAt: "2026-08-04T21:00:00Z",
      });
      expect(sid).toBe("paperclip:run-456:2026-08-04T21:00:00Z");
    });

    it("is deterministic for same inputs", () => {
      const params = { runId: "r2", usageUpdatedAt: "2026-06-01T12:00:00Z" };
      expect(computeSourceEventId(params)).toBe(computeSourceEventId(params));
    });
  });

  describe("integration: key + hash consistency", () => {
    it("payloadHash feeds into eventKey deterministically", () => {
      const payload = { runId: "r1", tokens: 42, provider: "nous" };
      const hash = computePayloadHash(payload);
      const key = computePaperclipRunEventKey({
        runId: payload.runId as string,
        usageUpdatedAt: "2026-08-04T20:00:00Z",
        payloadHash: hash,
      });
      expect(key).toContain(hash);
      expect(key).toMatch(/^paperclip:r1:.+:[a-f0-9]{64}$/);
    });
  });
});
