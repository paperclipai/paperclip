import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { prefetchWorkFiles } from "../services/work-folder-transfer.js";
import { uploadWorkFolderObject } from "../services/work-folder-upload.js";
import { measureSandboxOperation, measureSandboxStream, runWithSandboxPerformanceTrace, type SandboxPerformanceRecord } from "../services/sandbox-performance.js";

const entry = { path: "private-file-secret", kind: "file" as const, byteSize: 4, sha256: null, executable: false };
async function traced(work: () => Promise<void>) {
  const records: SandboxPerformanceRecord[] = [];
  await runWithSandboxPerformanceTrace({ runId: "private-run-secret", enabled: true, onBatch: async (batch) => { records.push(...batch.records); } }, work);
  return records;
}
describe("work-folder performance instrumentation", () => {
  it("separates ordered prefetch response waits from body consumption with safe attributes", async () => {
    const records = await traced(async () => measureSandboxOperation("work_folder.scope.hydrate", { scope: "task" }, async () => {
      for await (const transfer of prefetchWorkFiles([0, 1], async (fileIndex) => ({
        entry, body: measureSandboxStream("work_folder.object.body", { fileIndex }, Readable.from([Buffer.from("data")])),
      }))) {
        let body = ""; for await (const chunk of transfer.body!) body += String(chunk);
        expect(body).toBe("data");
      }
    }));
    const parent = records.find((record) => record.name === "work_folder.scope.hydrate")!;
    expect(records.filter((record) => record.name === "work_folder.prefetch.open")).toHaveLength(2);
    expect(records.filter((record) => record.name === "work_folder.prefetch.wait")).toHaveLength(2);
    const bodies = records.filter((record) => record.name === "work_folder.object.body");
    expect(bodies).toHaveLength(2);
    expect(bodies.every((record) => record.attributes.bytes === 4 && record.parentId === parent.id)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private-file-secret");
    expect(JSON.stringify(records)).not.toContain("private-run-secret");
  });
  it("records real PUT attempts and verified consumption without object keys or contents", async () => {
    const bytes = Buffer.from("private-body-secret"); let attempts = 0;
    const records = await traced(async () => {
      await uploadWorkFolderObject({ async putObject(input) {
        attempts++; for await (const _chunk of input.body) { /* actual consumption */ }
        if (attempts === 1) throw Object.assign(new Error("transient"), { code: "ECONNRESET" });
        return { objectKey: input.objectKey, contentLength: bytes.length } as never;
      } }, { objectKey: "private-object-secret", contentType: "text/plain", contentLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), createSource: () => Readable.from([bytes]) });
    });
    const puts = records.filter((record) => record.name === "work_folder.object.put");
    expect(puts.map((record) => [record.attributes.attempt, record.outcome])).toEqual([[1, "failed"], [2, "ok"]]);
    expect(records.filter((record) => record.name === "work_folder.upload.consume").every((record) => record.attributes.bytes === bytes.length)).toBe(true);
    expect(JSON.stringify(records)).not.toContain("private-object-secret");
    expect(JSON.stringify(records)).not.toContain("private-body-secret");
  });
  it("preserves queued response errors and closes unconsumed prefetched sources with tracing enabled", async () => {
    const source = new Readable({ read() {} });
    await expect(traced(async () => {
      for await (const transfer of prefetchWorkFiles([0, 1], async (index) => ({ entry,
        body: measureSandboxStream("work_folder.object.body", { fileIndex: index }, index === 0 ? Readable.from([]) : source),
      }))) {
        if (transfer.entry === entry && !source.destroyed) {
          source.destroy(new Error("queued response failed")); await new Promise((resolve) => setImmediate(resolve));
        }
        for await (const _chunk of transfer.body!) { /* consume */ }
      }
    })).rejects.toThrow("queued response failed");
    expect(source.destroyed).toBe(true);
    const abandoned = new Readable({ read() {} });
    await traced(async () => {
      for await (const _transfer of prefetchWorkFiles([0], async () => ({ entry, body: measureSandboxStream("work_folder.object.body", {}, abandoned) }))) break;
    });
    expect(abandoned.destroyed).toBe(true);
  });
});
