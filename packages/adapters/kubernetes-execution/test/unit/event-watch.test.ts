import { describe, it, expect, vi } from "vitest";
import { startEventWatch } from "../../src/orchestrator/event-watch.js";

function bodyFromEvents(
  events: Array<{ type: string; object: Record<string, unknown> }>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      }
      controller.close();
    },
  });
}

function clientStreaming(
  events: Array<{ type: string; object: Record<string, unknown> }>,
): Parameters<typeof startEventWatch>[0]["client"] {
  return {
    requestStream: vi.fn(async () => new Response(bodyFromEvents(events))),
  } as unknown as Parameters<typeof startEventWatch>[0]["client"];
}

describe("startEventWatch", () => {
  it("forwards Warning events about the Job with [k8s] prefix and ignores Normal", async () => {
    const client = clientStreaming([
      {
        type: "MODIFIED",
        object: {
          metadata: { resourceVersion: "1" },
          type: "Warning",
          reason: "ImagePullBackOff",
          message: "pull failed",
          involvedObject: { kind: "Job", name: "job-x" },
        },
      },
      {
        type: "MODIFIED",
        object: {
          metadata: { resourceVersion: "2" },
          type: "Normal",
          reason: "Created",
          message: "created pod",
          involvedObject: { kind: "Job", name: "job-x" },
        },
      },
    ]);

    const collected: string[] = [];
    const handle = startEventWatch({
      client,
      namespace: "ns",
      jobName: "job-x",
      onLog: async (_s, c) => {
        collected.push(c);
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.abort();
    await handle.done;
    expect(collected).toEqual(["[k8s] ImagePullBackOff: pull failed"]);
  });

  it("forwards Pod-level Warning events whose name starts with the Job name", async () => {
    // OOMKilling, BackOff, ImagePullBackOff, Failed are emitted against the
    // Pod (whose name is `<jobName>-<hash>`), not the Job. Without the
    // Pod-name prefix match these fixed P1: pre-fix we silently dropped
    // every actionable failure signal during a run.
    const client = clientStreaming([
      {
        type: "MODIFIED",
        object: {
          metadata: { resourceVersion: "1" },
          type: "Warning",
          reason: "OOMKilling",
          message: "memory cgroup OOM",
          involvedObject: { kind: "Pod", name: "job-x-abc12" },
        },
      },
      {
        type: "MODIFIED",
        object: {
          metadata: { resourceVersion: "2" },
          type: "Warning",
          reason: "BackOff",
          message: "back-off restarting failed container",
          involvedObject: { kind: "Pod", name: "job-x-abc12" },
        },
      },
    ]);

    const collected: string[] = [];
    const handle = startEventWatch({
      client,
      namespace: "ns",
      jobName: "job-x",
      onLog: async (_s, c) => {
        collected.push(c);
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.abort();
    await handle.done;
    expect(collected).toEqual([
      "[k8s] OOMKilling: memory cgroup OOM",
      "[k8s] BackOff: back-off restarting failed container",
    ]);
  });

  it("ignores events for unrelated objects in the same namespace", async () => {
    const client = clientStreaming([
      {
        type: "MODIFIED",
        object: {
          metadata: { resourceVersion: "1" },
          type: "Warning",
          reason: "FailedScheduling",
          message: "other tenant's pod",
          involvedObject: { kind: "Pod", name: "other-job-xyz99" },
        },
      },
      {
        type: "MODIFIED",
        object: {
          metadata: { resourceVersion: "2" },
          type: "Warning",
          reason: "FailedMount",
          message: "unrelated job",
          involvedObject: { kind: "Job", name: "neighbor-job" },
        },
      },
    ]);

    const collected: string[] = [];
    const handle = startEventWatch({
      client,
      namespace: "ns",
      jobName: "job-x",
      onLog: async (_s, c) => {
        collected.push(c);
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.abort();
    await handle.done;
    expect(collected).toEqual([]);
  });
});
