import { describe, expect, it } from "vitest";
import { readZipArchive } from "./portability-zip.js";
import { createDeflatedZipArchive, crc32Bytes } from "./zip-writer.js";

const encoder = new TextEncoder();

describe("zip writer", () => {
  it("round-trips text files through the shared reader", async () => {
    const archive = createDeflatedZipArchive({
      "run.json": encoder.encode(JSON.stringify({ id: "run-1" })),
      "events.jsonl": encoder.encode('{"seq":1}\n{"seq":2}\n'),
      "log.txt": encoder.encode("hello\n".repeat(1000)),
    });
    const read = await readZipArchive(archive);
    expect(Object.keys(read.files).sort()).toEqual(["events.jsonl", "log.txt", "run.json"]);
    expect(read.files["run.json"]).toEqual(JSON.stringify({ id: "run-1" }));
    expect(read.files["log.txt"]).toEqual("hello\n".repeat(1000));
  });

  it("compresses repetitive content", () => {
    const body = encoder.encode("a".repeat(100_000));
    const archive = createDeflatedZipArchive({ "big.txt": body });
    expect(archive.length).toBeLessThan(body.length / 10);
  });

  it("computes standard CRC-32", () => {
    expect(crc32Bytes(encoder.encode("123456789")).toString(16)).toBe("cbf43926");
  });

  it("rejects bad levels and empty input", () => {
    const files = { "a.txt": encoder.encode("a") };
    expect(() => createDeflatedZipArchive(files, { compressionLevel: 10 })).toThrow(/0-9/);
    expect(() => createDeflatedZipArchive(files, { compressionLevel: 1.5 })).toThrow(/0-9/);
    expect(() => createDeflatedZipArchive({})).toThrow(/at least one file/);
  });
});
