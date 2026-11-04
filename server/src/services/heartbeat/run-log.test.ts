import { describe, expect, it } from "vitest";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import {
  appendExcerpt,
  boundHeartbeatRunEventPayloadForStorage,
  compactRunLogChunk,
  redactCanonicalNativeRunLogChunk,
} from "./run-log.js";

describe("heartbeat run-log excerpts", () => {
  it("appends chunks while preserving the most recent 32 KiB of output", () => {
    const prefix = "x".repeat(32 * 1024);
    expect(appendExcerpt("ready", "\nnext")).toBe("ready\nnext");
    const full = appendExcerpt(prefix, "tail");
    expect(full).toBe(`${"x".repeat(32 * 1024 - 4)}tail`);
    expect(appendExcerpt(full, "next")).toBe(`${"x".repeat(32 * 1024 - 8)}tailnext`);
  });

  it("respects the byte limit without splitting a multibyte character", () => {
    const suffix = "x".repeat(32 * 1024 - 4);
    const excerpt = appendExcerpt(`🙂${suffix}`, "y");
    expect(excerpt).toBe(`${suffix}y`);
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(32 * 1024);
  });
});

describe("heartbeat run-log payload formatting", () => {
  it("preserves ordinary values, serializes dates, and replaces unsupported values", () => {
    expect(boundHeartbeatRunEventPayloadForStorage({
      text: "ready",
      count: 2,
      flag: false,
      empty: null,
      at: new Date("2026-10-08T12:00:00Z"),
      missing: undefined,
      callback: () => "unused",
      symbol: Symbol("unused"),
      bigint: 1n,
    })).toEqual({
      text: "ready",
      count: 2,
      flag: false,
      empty: null,
      at: "2026-10-08T12:00:00.000Z",
      missing: null,
      callback: null,
      symbol: null,
      bigint: null,
    });
  });

  it("keeps strings at the limit and reports the exact number of omitted characters", () => {
    const limit = "x".repeat(16 * 1024);
    expect(boundHeartbeatRunEventPayloadForStorage({
      exact: limit,
      oversized: `${limit}end`,
    })).toEqual({
      exact: limit,
      oversized: `${limit}\n[truncated 3 chars]`,
    });
  });

  it("keeps the first 50 array entries and reports omitted items", () => {
    const exact = Array.from({ length: 50 }, (_, index) => index);
    expect(boundHeartbeatRunEventPayloadForStorage({ exact, oversized: [...exact, 50, 51] }))
      .toEqual({ exact, oversized: [...exact, { _truncated: true, omittedItems: 2 }] });
  });

  it("keeps the first 100 object keys and reports omitted keys", () => {
    const exact = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index]));
    expect(boundHeartbeatRunEventPayloadForStorage({
      exact,
      oversized: { ...exact, extra1: 1, extra2: 2 },
    })).toEqual({
      exact,
      oversized: { ...exact, _truncated: true, _omittedKeys: 2 },
    });
  });

  it("replaces objects at the depth limit with at most 20 key names", () => {
    const leaf = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`key${index}`, "hidden"]));
    const payload = { one: { two: { three: { four: { five: { six: leaf } } } } } };
    expect(boundHeartbeatRunEventPayloadForStorage(payload)).toEqual({
      one: { two: { three: { four: { five: { six: {
        _truncated: true,
        type: "object",
        keys: Object.keys(leaf).slice(0, 20),
      } } } } } },
    });
  });

  it("replaces arrays at the depth limit with their original length", () => {
    const payload = { one: { two: { three: { four: { five: { six: [1, 2, 3] } } } } } };
    expect(boundHeartbeatRunEventPayloadForStorage(payload)).toEqual({
      one: { two: { three: { four: { five: { six: {
        _truncated: true,
        type: "array",
        originalLength: 3,
      } } } } } },
    });
  });

  it("marks object cycles while preserving repeated references in separate branches", () => {
    const shared = { text: "same value" };
    const payload: Record<string, unknown> = { first: shared, second: shared };
    payload.self = payload;
    expect(boundHeartbeatRunEventPayloadForStorage(payload)).toEqual({
      first: { text: "same value" },
      second: { text: "same value" },
      self: "[Circular]",
    });
  });

  it("bounds a self-referencing array without changing it", () => {
    const entries: unknown[] = [];
    entries.push(entries);
    const result = boundHeartbeatRunEventPayloadForStorage({ entries });
    expect(JSON.stringify(result)).toBe('{"entries":[[[[[{"_truncated":true,"type":"array","originalLength":1}]]]]]}');
    expect(entries[0]).toBe(entries);
  });

  it("leaves frozen input values unchanged and creates independent output", () => {
    const nested = Object.freeze({ text: "x".repeat(20_000) });
    const entries = Object.freeze([nested]);
    const payload = Object.freeze({ nested, entries });
    const first = boundHeartbeatRunEventPayloadForStorage(payload);
    const second = boundHeartbeatRunEventPayloadForStorage(payload);
    expect(first).toEqual(second);
    expect(first.nested).not.toBe(nested);
    expect(first.entries).not.toBe(entries);
    expect(nested.text).toHaveLength(20_000);
    expect(entries[0]).toBe(nested);
  });
});

describe("heartbeat run-log chunk formatting", () => {
  it("preserves ordinary chunks through the default 64 KiB character limit", () => {
    const chunk = "x".repeat(64 * 1024);
    expect(compactRunLogChunk("")).toBe("");
    expect(compactRunLogChunk("ready\n")).toBe("ready\n");
    expect(compactRunLogChunk(chunk)).toBe(chunk);
  });

  it("keeps the existing head, tail, and omission count for a custom limit", () => {
    expect(compactRunLogChunk(`${"x".repeat(95)}tail!`, 20)).toBe(
      `${"x".repeat(12)}\n[paperclip truncated run log chunk: omitted 83 chars]\ntail!`,
    );
  });

  it.each([1023, 1024])("preserves the image omission threshold at %i characters", (length) => {
    const data = "A".repeat(length);
    const chunk = `{"type":"image","source":{"type":"base64","data":"${data}"}}`;
    expect(compactRunLogChunk(chunk)).toBe(length < 1024
      ? chunk
      : chunk.replace(data, `[omitted base64 image data: ${length} chars]`));
  });

  it("omits every large image consistently across repeated calls", () => {
    const chunk = [1024, 2048].map((length) =>
      `{"type":"image","source":{"type":"base64","data":"${"A".repeat(length)}"}}`,
    ).join("\n");
    const expected = [1024, 2048].map((length) =>
      `{"type":"image","source":{"type":"base64","data":"[omitted base64 image data: ${length} chars]"}}`,
    ).join("\n");
    expect(compactRunLogChunk(chunk)).toBe(expected);
    expect(compactRunLogChunk(chunk)).toBe(expected);
  });

  it("redacts credentials and image data before deciding whether a chunk needs truncation", () => {
    const chunk = `Authorization: Bearer fixture-secret-token\n{"type":"image","source":{"type":"base64","data":"${"A".repeat(70_000)}"}}`;
    const compacted = compactRunLogChunk(chunk, 512);
    expect(compacted).toContain("***REDACTED***");
    expect(compacted).not.toContain("fixture-secret-token");
    expect(compacted).toContain("[omitted base64 image data: 70000 chars]");
    expect(compacted).not.toContain("[paperclip truncated");
  });
});

describe("complete canonical native log privacy", () => {
  it.each([false, true])("keeps structured bytes and applies complete-value secrets, images, and username masking: %s", enabled => {
    const identity = createAgentIdentityRedactor("fixture-configured-private-canary");
    const envelope = { type: "paperclip.prp.event", event: {
      schema: "paperclip.prp.event.v1", schemaVersion: 1, eventType: "item.delta",
      payload: { header: 'Authorization: Bearer fixture-bearer-canary', api_key: "fixture-api-canary",
        text: 'quoted "fixture-configured-private-canary" by fixture-operator',
        image: { source: { data: "A".repeat(70000), type: "base64" }, type: "image" },
        parts: Array.from({ length: 20 }, () => "full content ".repeat(400)),
      },
    } };
    const chunk = redactCanonicalNativeRunLogChunk(JSON.stringify(envelope), {
      redactIdentity: identity.redact, currentUser: { enabled, userNames: ["fixture-operator"], homeDirs: [] },
    });
    const result = JSON.parse(chunk).event;
    expect(result.schema).toBe(envelope.event.schema);
    expect(result.payload.header).toBe("Authorization: ***REDACTED***");
    expect(result.payload.api_key).toBe("***REDACTED***");
    expect(result.payload.text).toContain('quoted "***REDACTED***" by ');
    expect(result.payload.text.includes("fixture-operator")).toBe(!enabled);
    expect(result.payload.parts).toEqual(envelope.event.payload.parts);
    expect(result.payload.image.source.data).toBe("[omitted base64 image data: 70000 chars]");
    for (const secret of ["fixture-configured-private-canary", "fixture-bearer-canary", "fixture-api-canary"])
      expect(chunk).not.toContain(secret);
    expect(chunk).not.toContain("data:image");
    expect(chunk.length).toBeGreaterThan(64 * 1024);
    expect(chunk).not.toContain("[paperclip truncated");
  });

  it("rejects malformed owned envelopes instead of treating them as coverage-preserving diagnostics", () => {
    const options = { redactIdentity: <T>(value: T) => value, currentUser: { enabled: false } };
    for (const chunk of ['{"type":"paperclip.prp.event",', '{"type":"diagnostic","event":{}}',
      '{"type":"paperclip.prp.event","event":[]}'])
      expect(() => redactCanonicalNativeRunLogChunk(chunk, options)).toThrow();
  });
});
