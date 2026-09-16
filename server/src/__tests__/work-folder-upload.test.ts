import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { uploadWorkFolderObject } from "../services/work-folder-upload.js";

const data = Buffer.from("verified file contents\n");
const reset = () => Object.assign(new Error("socket hang up"), { name: "TimeoutError", code: "ECONNRESET" });
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const input = { objectKey: "company/repository/blob", contentType: "application/octet-stream", contentLength: data.length, sha256: digest(data) };
async function bytes(body: Buffer | Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("replayable verified work-folder uploads", () => {
  it.each(["partial", "complete"])("reopens and verifies the whole source after a reset following %s consumption", async (consumption) => {
    const sources: Readable[] = [], bodies: Readable[] = [];
    let attempt = 0;
    const putObject = vi.fn(async ({ body, objectKey }) => {
      expect(objectKey).toBe(input.objectKey);
      bodies.push(body);
      if (++attempt === 1) {
        if (consumption === "complete") expect(await bytes(body)).toEqual(data);
        else await body.iterator({ destroyOnReturn: false }).next();
        throw reset();
      }
      expect(await bytes(body)).toEqual(data);
    });
    await uploadWorkFolderObject({ putObject }, { ...input, createSource: () => {
      const stream = Readable.from([data.subarray(0, 3), data.subarray(3)]); sources.push(stream); return stream;
    } });
    expect(putObject).toHaveBeenCalledTimes(2);
    expect(new Set(bodies).size).toBe(2);
    expect(sources.every((source) => source.destroyed)).toBe(true);
    expect(bodies.every((body) => body.destroyed)).toBe(true);
  });

  it("waits for the previous PUT to settle before reopening a failed source", async () => {
    let release!: () => void;
    let failed!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const sourceFailed = new Promise<void>((resolve) => { failed = resolve; });
    let attempts = 0;
    const createSource = vi.fn(() => ++attempts === 1
      ? Readable.from((async function* () { yield data.subarray(0, 3); failed(); throw reset(); })())
      : Readable.from([data]));
    const putObject = vi.fn(async ({ body }) => {
      if (attempts === 1) { await held; throw reset(); }
      expect(await bytes(body)).toEqual(data);
    });
    const upload = uploadWorkFolderObject({ putObject }, { ...input, createSource });
    await sourceFailed;
    // Longer than the retry delay: an unsettled old request must still own the key.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(createSource).toHaveBeenCalledTimes(1);
    release();
    await upload;
    expect(createSource).toHaveBeenCalledTimes(2);
  });

  it("stops after three failed attempts and destroys every source", async () => {
    const sources: Readable[] = [];
    const putObject = vi.fn(async ({ body }) => { await bytes(body); throw reset(); });
    await expect(uploadWorkFolderObject({ putObject }, { ...input, createSource: () => {
      const source = Readable.from([data]); sources.push(source); return source;
    } })).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(putObject).toHaveBeenCalledTimes(3);
    expect(sources.every((source) => source.destroyed)).toBe(true);
  });

  it("rejects a changed source after a reset without publishing or another retry", async () => {
    let attempt = 0;
    const putObject = vi.fn(async ({ body }) => { await bytes(body); throw reset(); });
    await expect(uploadWorkFolderObject({ putObject }, { ...input, createSource: () => Readable.from([
      ++attempt === 1 ? data : Buffer.alloc(data.length, 120),
    ]) })).rejects.toThrow("Work file changed during upload");
    expect(putObject).toHaveBeenCalledTimes(2);
  });

  it.each([Buffer.from("short"), Buffer.alloc(data.length + 1), Buffer.alloc(data.length, 120)])("rejects size or hash changes without retrying", async (body) => {
    const putObject = vi.fn(async ({ body: stream }) => { await bytes(stream); });
    await expect(uploadWorkFolderObject({ putObject }, { ...input, createSource: () => Readable.from([body]) }))
      .rejects.toThrow("Work file changed during upload");
    expect(putObject).toHaveBeenCalledTimes(1);
  });

  it.each([
    Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } }),
    Object.assign(new Error("missing"), { code: "ENOENT" }),
    new Error("owner was deleted"),
  ])("does not replay a permanent or unclassified error", async (error) => {
    const source = Readable.from([data]);
    const putObject = vi.fn(async () => { throw error; });
    await expect(uploadWorkFolderObject({ putObject }, { ...input, createSource: () => source })).rejects.toBe(error);
    expect(putObject).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  });

  it("retries a classified temporary HTTP failure and supports empty files", async () => {
    let attempt = 0;
    const putObject = vi.fn(async ({ body }) => {
      expect(await bytes(body)).toEqual(Buffer.alloc(0));
      if (++attempt === 1) throw Object.assign(new Error("unavailable"), { $metadata: { httpStatusCode: 503 } });
    });
    await uploadWorkFolderObject({ putObject }, { ...input, contentLength: 0, sha256: digest(Buffer.alloc(0)), createSource: () => Readable.from([]) });
    expect(putObject).toHaveBeenCalledTimes(2);
  });
});
