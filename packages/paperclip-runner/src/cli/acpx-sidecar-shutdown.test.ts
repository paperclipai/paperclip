import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordSidecarShutdownThenQueue, sidecarShutdownSnapshot } from "./acpx-sidecar-shutdown.js";

describe("sidecar shutdown snapshot", () => {
  it("bounds samples, keeps the oldest calls and omits private data", () => {
    const tools = new Map(Array.from({ length: 512 }, (_, index) => [
      `private-call-${index}`,
      { startedAt: 1000 - index, arguments: "PRIVATE_INPUT", result: "PRIVATE_OUTPUT" },
    ]));
    const snapshot = sidecarShutdownSnapshot("sidecar stdin closed", tools, 3, 2, 1, 2000);
    expect(snapshot).toMatchObject({ pendingTools: 512, pendingInputs: 3, pendingPermissions: 2,
      normalizingTools: 1, truncatedTools: 496 });
    expect(snapshot.tools).toHaveLength(16);
    expect(snapshot.tools[0]).toEqual({
      callIdSha256: createHash("sha256").update("private-call-511").digest("hex"), elapsedMs: 1511,
    });
    expect(snapshot.tools[15]?.elapsedMs).toBe(1496);
    const encoded = JSON.stringify(snapshot);
    expect(Buffer.byteLength(encoded)).toBeLessThan(4096);
    expect(encoded).not.toMatch(/PRIVATE|private-call/);
    expect(tools.size).toBe(512);
  });

  it("records an idle shutdown without retaining completed calls", () => {
    expect(sidecarShutdownSnapshot("sidecar received SIGTERM", new Map(), 0, 0, 0)).toEqual({
      reason: "sidecar received SIGTERM", pendingTools: 0, pendingInputs: 0,
      pendingPermissions: 0, normalizingTools: 0, tools: [], truncatedTools: 0,
    });
  });

  it("records the snapshot before queueing shutdown", () => {
    const order: string[] = [];
    expect(recordSidecarShutdownThenQueue(() => order.push("record"), () => order.push("queue"))).toBe(true);
    expect(order).toEqual(["record", "queue"]);
  });

  it("still queues shutdown when the snapshot write throws", () => {
    const order: string[] = [];
    expect(recordSidecarShutdownThenQueue(() => {
      order.push("record");
      throw new Error("EPIPE: stdout closed");
    }, () => order.push("queue"))).toBe(false);
    expect(order).toEqual(["record", "queue"]);
  });
});
