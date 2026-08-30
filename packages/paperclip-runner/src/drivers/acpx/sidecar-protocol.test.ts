import { describe, expect, it } from "vitest";

import {
  ACPX_SIDECAR_MAX_FRAME_BYTES,
  boundedSidecarValue,
  parseAcpxSidecarRequest,
  sanitizeAcpxPlanEntries,
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
