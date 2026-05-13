import { describe, it, expect, vi } from "vitest";
import { startLogStream } from "../../src/orchestrator/log-stream.js";

function makeReadableBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.close();
    },
  });
}

describe("startLogStream", () => {
  it("forwards each newline-terminated line to onLog after stripping the leading timestamp", async () => {
    const collected: string[] = [];
    const mockClient = {
      requestStream: vi.fn(
        async () =>
          new Response(
            makeReadableBody([
              "2026-05-09T00:00:00Z hello\n",
              "2026-05-09T00:00:01Z world\n",
            ]),
          ),
      ),
    } as unknown as Parameters<typeof startLogStream>[0]["client"];

    const handle = startLogStream({
      client: mockClient,
      namespace: "ns",
      podName: "pod",
      containerName: "agent",
      onLog: async (_s, chunk) => {
        collected.push(chunk);
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    handle.abort();
    await handle.done;
    expect(collected).toEqual(["hello", "world"]);
  });

  it("reconnects on stream end while not aborted", async () => {
    const calls: string[][] = [["2026-05-09T00:00:00Z first\n"]];
    let callIdx = 0;
    const mockClient = {
      requestStream: vi.fn(async () => {
        const lines = calls[Math.min(callIdx++, calls.length - 1)] ?? [];
        return new Response(makeReadableBody(lines));
      }),
    } as unknown as Parameters<typeof startLogStream>[0]["client"];

    const collected: string[] = [];
    const handle = startLogStream({
      client: mockClient,
      namespace: "ns",
      podName: "pod",
      containerName: "agent",
      onLog: async (_s, chunk) => {
        collected.push(chunk);
      },
    });
    // Allow at least one reconnect cycle (500ms back-off after a clean stream end).
    await new Promise((r) => setTimeout(r, 800));
    handle.abort();
    await handle.done;
    expect(collected).toContain("first");
    // requestStream should have been called more than once because we kept reconnecting.
    expect((mockClient.requestStream as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
