import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableRunLogStore } from "../services/run-log-store.js";

// AGE-697: `readTail` is what makes adopted-run terminal-result recovery in
// heartbeat.ts's `reconstructRunLogStreamsTail` correct for a large
// transcript -- unlike forward pagination via `read` (bounded by a scan cap),
// it always reaches the true end of the log in a fixed number of requests
// regardless of total size. These tests exercise `readTail` directly against
// a real on-disk store, independent of heartbeat.ts's fixed production scan
// size, so a small `maxBytes` here still proves the tail-vs-truncation
// behavior a multi-megabyte transcript in production relies on.
//
// The NDJSON transcript escapes each event's `chunk` field (it is JSON
// stringified along with `ts`/`stream`/`seq`), so a raw terminal-result
// string embedded in a chunk never appears byte-for-byte in the file -- its
// quotes are backslash-escaped. `reconstructedStdout` below parses each line
// and concatenates `chunk` the same way production code does, so assertions
// run against the same reconstructed text a terminal-result parser would see.
function reconstructedStdout(content: string): string {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { stream?: unknown; chunk?: unknown };
        return event.stream === "stdout" && typeof event.chunk === "string" ? [event.chunk] : [];
      } catch {
        return [];
      }
    })
    .join("");
}

describe("run-log-store readTail", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
    );
  });

  async function makeStore() {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-store-test-"));
    tempDirs.push(basePath);
    return createDurableRunLogStore({ basePath });
  }

  it("returns the whole log with truncatedAtStart=false when it fits within maxBytes", async () => {
    const store = await makeStore();
    const handle = await store.begin({ companyId: "co", agentId: "agent", runId: randomUUID() });
    await store.append(handle, { stream: "stdout", chunk: "first\n", ts: "2026-01-01T00:00:00.000Z", seq: 1 });
    await store.append(handle, { stream: "stdout", chunk: "second\n", ts: "2026-01-01T00:00:01.000Z", seq: 2 });
    await store.finalize(handle);

    const tail = await store.readTail!(handle, { maxBytes: 10_000 });
    expect(tail.truncatedAtStart).toBe(false);
    expect(reconstructedStdout(tail.content)).toBe("first\nsecond\n");
  });

  it("reaches the true tail (not just a bounded forward scan) of a log far larger than maxBytes", async () => {
    const store = await makeStore();
    const handle = await store.begin({ companyId: "co", agentId: "agent", runId: randomUUID() });
    // Write enough lines that the log is unambiguously larger than the small
    // maxBytes used below -- this stands in for a multi-megabyte production
    // transcript without actually writing megabytes in a test.
    for (let i = 0; i < 200; i++) {
      await store.append(handle, {
        stream: "stdout",
        chunk: `padding-line-${i}-${"x".repeat(40)}\n`,
        ts: "2026-01-01T00:00:00.000Z",
        seq: i,
      });
    }
    const terminalMarker = JSON.stringify({ type: "result", subtype: "success", is_error: false });
    await store.append(handle, {
      stream: "stdout",
      chunk: `${terminalMarker}\n`,
      ts: "2026-01-01T00:01:00.000Z",
      seq: 1_000,
    });
    await store.finalize(handle);

    const maxBytes = 300;
    const tail = await store.readTail!(handle, { maxBytes });
    expect(tail.truncatedAtStart).toBe(true);
    expect(tail.content.length).toBeLessThanOrEqual(maxBytes);
    const reconstructed = reconstructedStdout(tail.content);
    // The tail read is clamped to maxBytes -- it must not contain the log's
    // very first written line (proves this is a true tail, not a bounded
    // forward scan from offset 0 that happened to stop early).
    expect(reconstructed).not.toContain("padding-line-0-");
    // But it must still reach the terminal marker near the true end,
    // regardless of how much padding precedes it in the file.
    expect(reconstructed).toContain(terminalMarker);
  });

  it("falls back to the S3-backed tail when the local file is gone (pod-roll simulation)", async () => {
    const basePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-run-log-store-test-"));
    tempDirs.push(basePath);
    let putBody: string | null = null;
    const fakeS3 = {
      provider: {
        async putObject(input: { objectKey: string; body: NodeJS.ReadableStream }) {
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            input.body.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            input.body.on("error", reject);
            input.body.on("end", () => resolve());
          });
          putBody = Buffer.concat(chunks).toString("utf8");
        },
        async headObject() {
          return putBody === null
            ? { exists: false }
            : { exists: true, contentLength: Buffer.byteLength(putBody, "utf8") };
        },
        async getObject(input: { range?: { start: number; end: number } }) {
          const { Readable } = await import("node:stream");
          const body = putBody ?? "";
          const sliced = input.range ? body.slice(input.range.start, input.range.end + 1) : body;
          return { stream: Readable.from([Buffer.from(sliced, "utf8")]) };
        },
      },
    };
    const store = createDurableRunLogStore({
      basePath,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      s3: fakeS3 as any,
    });
    const handle = await store.begin({ companyId: "co", agentId: "agent", runId: randomUUID() });
    const terminalMarker = JSON.stringify({ type: "result", is_error: false });
    await store.append(handle, { stream: "stdout", chunk: `${terminalMarker}\n`, ts: "2026-01-01T00:00:00.000Z", seq: 1 });
    await store.finalize(handle);

    // Simulate the pod-roll: the local emptyDir is gone, only the S3 mirror remains.
    await fs.rm(path.join(basePath, handle.logRef), { force: true });

    const tail = await store.readTail!(handle, { maxBytes: 10_000 });
    expect(reconstructedStdout(tail.content)).toContain(terminalMarker);
  });
});
