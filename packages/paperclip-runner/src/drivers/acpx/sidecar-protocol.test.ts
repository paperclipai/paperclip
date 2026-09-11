import { describe, expect, it } from "vitest";

import {
  ACPX_SIDECAR_MAX_FRAME_BYTES,
  boundedSidecarText,
  boundedSidecarValue,
  frameAcpxToolClassification,
  parseAcpxSidecarRequest,
  safeSidecarText,
  sanitizeAcpxPlanEntries,
  stringifyAcpxSidecarFrame,
} from "./sidecar-protocol.js";

describe("ACPX sidecar request parsing", () => {
  it("accepts only bounded, versioned, generated commands", () => {
    expect(
      parseAcpxSidecarRequest({
        protocolVersion: 2,
        id: 1,
        command: "session.open",
        params: { cwd: "/workspace" },
      }),
    ).toEqual({
      protocolVersion: 2,
      id: 1,
      command: "session.open",
      params: { cwd: "/workspace" },
    });
    expect(() =>
      parseAcpxSidecarRequest({
        protocolVersion: 3,
        id: 1,
        command: "session.open",
        params: {},
      }),
    ).toThrow("unsupported ACPX sidecar protocol version");
    expect(() =>
      parseAcpxSidecarRequest({
        protocolVersion: 2,
        id: 1,
        command: "session.destroy",
        params: {},
      }),
    ).toThrow("unsupported ACPX sidecar command");
    expect(() =>
      parseAcpxSidecarRequest({
        protocolVersion: 2,
        id: 1,
        command: "session.open",
        params: [],
      }),
    ).toThrow("params must be an object");
    expect(() =>
      parseAcpxSidecarRequest({
        protocolVersion: 2,
        id: 1,
        command: "session.open",
        params: {},
        extra: true,
      }),
    ).toThrow("unknown field");
  });

  it("bounds and safely sanitizes arbitrary values", () => {
    expect(() =>
      parseAcpxSidecarRequest({
        protocolVersion: 2,
        id: 1,
        command: "initialize",
        params: { value: "x".repeat(ACPX_SIDECAR_MAX_FRAME_BYTES) },
      }),
    ).toThrow("frame limit");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedSidecarValue(cyclic)).toEqual({
      omitted: true,
      reason: "serialization_failed",
    });
    expect(boundedSidecarValue(["not", "an", "object"])).toEqual({
      omitted: true,
      reason: "object_required",
    });
  });

  it("bounds tool text on Unicode scalar boundaries", () => {
    const prefix = "x".repeat(3_999);
    const title = boundedSidecarText(`${prefix}🚀write`, 4_000);

    expect([...title]).toHaveLength(4_000);
    expect(title).toBe(`${prefix}🚀`);
    expect(
      boundedSidecarValue({ type: "tool_call", title }, 128 * 1024),
    ).toEqual({ type: "tool_call", title });
    expect(boundedSidecarText(`safe\ud83d`, 10)).toBe("safe\uFFFD");
  });

  it("classifies an oversized tool kind before retaining its bounded frame value", () => {
    const classification = frameAcpxToolClassification(
      `${"x".repeat(128 * 1024)}\ud800WRITE`,
      "Provider tool",
    );
    const payload = boundedSidecarValue(
      {
        type: "tool_call",
        toolCallId: "tool-oversized-kind",
        title: "Provider tool",
        ...classification,
        locations: [],
      },
      128 * 1024,
    );

    expect(payload).toMatchObject({
      type: "tool_call",
      kind: "x".repeat(4_000),
      toolOperation: "edit",
    });
    expect(payload).not.toHaveProperty("omitted");
    expect(stringifyAcpxSidecarFrame(payload)).not.toMatch(
      /\\ud[89ab][0-9a-f]{2}|\\ud[c-f][0-9a-f]{2}/iu,
    );
  });

  it("preserves a bounded tool-call identity when aggregate fields overflow", () => {
    const identity = {
      type: "tool_call",
      toolCallId: "tool-aggregate-overflow",
      title: "Write",
      kind: "write",
      toolOperation: "edit",
    };

    expect(
      boundedSidecarValue(
        { ...identity, locations: [{ path: "x".repeat(140 * 1024) }] },
        128 * 1024,
        identity,
      ),
    ).toEqual({
      ...identity,
      omitted: true,
      reason: "payload_limit",
    });
  });

  it("emits only Rust-decodable Unicode scalar values in sidecar frames", () => {
    const frame = stringifyAcpxSidecarFrame({
      payload: {
        toolCallId: `call-\ud800`,
        kind: `wr\udfffite`,
        status: `pend\ud800ing`,
        input: {
          [`nested-\ud800`]: { [`result-\udfff`]: "retained" },
        },
      },
    });

    expect(frame).not.toMatch(/\\ud[89ab][0-9a-f]{2}|\\ud[c-f][0-9a-f]{2}/iu);
    expect(JSON.parse(frame)).toEqual({
      payload: {
        toolCallId: "call-\uFFFD",
        kind: "wr\uFFFDite",
        status: "pend\uFFFDing",
        input: {
          "nested-\uFFFD": { "result-\uFFFD": "retained" },
        },
      },
    });
    expect(safeSidecarText(`read\ud83d🚀\udc00write`)).toBe(
      "read\uFFFD🚀\uFFFDwrite",
    );
  });
});

describe("ACPX sidecar structured plans", () => {
  it("preserves every valid ordered entry while bounding and sanitizing the snapshot", () => {
    const entries = sanitizeAcpxPlanEntries([
      { content: " Inspect ", status: "completed", priority: "high" },
      { content: "Implement", status: "in_progress", priority: "medium" },
      { content: "Verify", status: "pending", priority: "low" },
      { content: "Invalid status", status: "failed" },
      { content: "   ", status: "pending" },
      {
        content: "x".repeat(5_000),
        status: "pending",
        priority: "p".repeat(100),
      },
    ]);

    expect(entries.slice(0, 3)).toEqual([
      { content: "Inspect", status: "completed", priority: "high" },
      { content: "Implement", status: "in_progress", priority: "medium" },
      { content: "Verify", status: "pending", priority: "low" },
    ]);
    expect(entries).toHaveLength(4);
    expect(entries[3]?.content).toHaveLength(4_000);
    expect(entries[3]?.priority).toHaveLength(80);
    expect(
      sanitizeAcpxPlanEntries(
        Array.from({ length: 300 }, (_, index) => ({
          content: `Step ${index}`,
          status: "pending",
        })),
      ),
    ).toHaveLength(256);
  });
});
