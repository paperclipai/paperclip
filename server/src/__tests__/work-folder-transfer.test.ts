import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { prefetchWorkFiles } from "../services/work-folder-transfer.js";

const entry = { path: "file", kind: "file" as const, byteSize: 0, sha256: null, executable: false };
describe("bounded work file prefetch", () => {
  it("preserves order and keeps at most sixteen streams open", async () => {
    let opened = 0, peak = 0;
    const seen: string[] = [];
    for await (const transfer of prefetchWorkFiles(Array.from({ length: 30 }, (_, i) => i), async (i) => {
      opened++; peak = Math.max(peak, opened);
      const body = new Readable({ read() { this.push(null); }, destroy(_error, done) { opened--; done(); } });
      return { entry: { ...entry, path: String(i) }, body };
    })) seen.push(transfer.entry.path);
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
    expect(peak).toBe(16);
    expect(opened).toBe(0);
  });
  it("opens a bounded response window without reading queued bodies", async () => {
    const bodies: Readable[] = [];
    let reads = 0;
    const transfers = prefetchWorkFiles(Array.from({ length: 40 }, (_, i) => i), async (i) => {
      const body = new Readable({ read() { reads++; this.push(Buffer.alloc(1024)); } });
      bodies.push(body);
      return { entry: { ...entry, path: String(i), byteSize: 1024 }, body };
    });
    try {
      const first = await transfers.next();
      expect(first.value?.entry.path).toBe("0");
      expect(bodies).toHaveLength(16);
      expect(reads).toBe(0);
    } finally {
      await transfers.return();
    }
    expect(bodies.every((body) => body.destroyed)).toBe(true);
    expect(reads).toBe(0);
  });
  it("handles a prefetched stream failure before the consumer reaches it", async () => {
    const source = new Readable({ read() {} });
    await expect((async () => {
      for await (const transfer of prefetchWorkFiles([0, 1], async (i) => ({
        entry, body: i === 0 ? Readable.from([]) : source,
      }))) {
        if (transfer.body === source) for await (const _chunk of source) { /* consume */ }
        else {
          source.destroy(new Error("queued response failed"));
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    })()).rejects.toThrow("queued response failed");
    expect(source.destroyed).toBe(true);
  });
  it("closes pending responses after consumer cancellation and asynchronous open failures", async () => {
    const streams: Readable[] = [];
    const open = async (i: number) => {
      await new Promise((resolve) => setTimeout(resolve, i * 2));
      if (i === 2) throw new Error("storage unavailable");
      const body = Readable.from([]); streams.push(body);
      return { entry, body };
    };
    for await (const _transfer of prefetchWorkFiles(Array.from({ length: 40 }, (_, i) => i), open)) break;
    expect(streams).toHaveLength(15);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    streams.length = 0;
    await expect((async () => {
      for await (const _transfer of prefetchWorkFiles(Array.from({ length: 40 }, (_, i) => i), open)) { /* consume */ }
    })()).rejects.toThrow("storage unavailable");
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });
});
