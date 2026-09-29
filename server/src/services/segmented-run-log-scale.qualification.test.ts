import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createSegmentedRunLogStore } from "./segmented-run-log-store.js";

it.skipIf(process.env.PAPERCLIP_SEGMENTED_LOG_SCALE !== "1")("streams 256 MiB through append, verifies every byte, and resumes without old segments", async () => {
  const basePath = await fs.mkdtemp(join(tmpdir(), "paperclip-log-growth-"));
  const reportPath = process.env.PAPERCLIP_SEGMENTED_LOG_REPORT;
  try {
    let store = createSegmentedRunLogStore({ basePath });
    const handle = await store.begin({ companyId: "qualification", agentId: "agent", runId: "scale" });
    const expected = createHash("sha256");
    let total = 0;
    const began = performance.now();
    while (total < 256 * 1024 * 1024) {
      const event = { stream: "stdout" as const, ts: new Date().toISOString(), chunk: randomBytes(3 * 1024 * 1024).toString("base64") };
      const line = Buffer.from(JSON.stringify(event) + "\n");
      total += await store.append(handle, event);
      expected.update(line);
    }
    const appendMs = performance.now() - began;
    const actual = createHash("sha256");
    let cursor = "0";
    for (;;) {
      const page = await store.read(handle, { cursor, limitBytes: 1024 * 1024 });
      actual.update(page.content);
      cursor = page.cursor!;
      if (!page.hasMore) break;
    }
    expect(cursor).toBe(String(total));
    expect(actual.digest("hex")).toBe(expected.digest("hex"));
    const directory = join(basePath, handle.logRef);
    const headBytes = (await fs.stat(join(directory, "head.json"))).size;
    let allocatedBytes = 0, segments = 0;
    for (const group of await fs.readdir(join(directory, "segments"))) {
      for (const file of await fs.readdir(join(directory, "segments", group))) {
        if (!file.endsWith(".ndjson")) continue;
        const stat = await fs.stat(join(directory, "segments", group, file));
        allocatedBytes += stat.blocks * 512; segments++;
        expect(stat.size).toBeLessThanOrEqual(32 * 1024 * 1024);
      }
    }
    expect(allocatedBytes).toBeGreaterThanOrEqual(total);
    await fs.rename(join(directory, "segments/00/00.ndjson"), join(directory, "unavailable-old-segment"));
    store = createSegmentedRunLogStore({ basePath });
    const resume = performance.now();
    await store.begin({ companyId: "qualification", agentId: "agent", runId: "scale" });
    const reopenMs = performance.now() - resume;
    await store.append(handle, { stream: "stdout", ts: "resumed", chunk: "continued after 256 MiB" });
    const finalize = performance.now();
    const summary = await store.finalize(handle);
    const finalizeMs = performance.now() - finalize;
    expect((await store.read(handle, { cursor })).content).toContain("continued after 256 MiB");
    const report = { schema: "paperclip.segmented-log-growth.v1", status: "passed", totalBytes: total, allocatedBytes, segments, headBytes, appendMs, reopenMs, finalizeMs, finalizedBytes: summary.bytesExact };
    if (reportPath) await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } finally { await fs.rm(basePath, { recursive: true, force: true }); }
}, 300_000);
