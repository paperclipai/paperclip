import { createHash } from "node:crypto";
import { PassThrough, Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { StorageService } from "../storage/types.js";
import { hydrateOutboundAttachment } from "./chat-channels.js";

function storageWithGetObject(
  getObject: StorageService["getObject"],
): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(),
    getObject,
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

function digest(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

describe("outbound attachment hydration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns only bytes matching the persisted size and SHA-256", async () => {
    const body = Buffer.from("verified outbound attachment", "utf8");
    const storage = storageWithGetObject(
      vi.fn(async () => ({
        stream: Readable.from([body]),
        contentLength: body.length,
      })),
    );

    await expect(
      hydrateOutboundAttachment({
        storage,
        companyId: "company-1",
        objectKey: "private/object",
        byteSize: body.length,
        sha256: digest(body),
        filename: "verified.txt",
        mimeType: "text/plain",
      }),
    ).resolves.toEqual({
      data: body,
      filename: "verified.txt",
      mimeType: "text/plain",
    });
  });

  it("rejects same-sized object-store bytes whose digest changed", async () => {
    const registered = Buffer.from("registered bytes", "utf8");
    const replaced = Buffer.from(registered);
    replaced[0] = "R".charCodeAt(0);
    expect(replaced.length).toBe(registered.length);
    const storage = storageWithGetObject(
      vi.fn(async () => ({
        stream: Readable.from([replaced]),
        contentLength: replaced.length,
      })),
    );

    const error = await hydrateOutboundAttachment({
      storage,
      companyId: "company-1",
      objectKey: "private/object",
      byteSize: registered.length,
      sha256: digest(registered),
      filename: "evidence.txt",
      mimeType: "text/plain",
    }).catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "OutboundAttachmentHydrationError",
      code: "CHAT_ATTACHMENT_HYDRATION_FAILED",
      message:
        "Chat publication attachment integrity changed after registration",
    });
  });

  it("bounds object acquisition and destroys an object that resolves after timeout", async () => {
    vi.useFakeTimers();
    const lateStream = new PassThrough();
    let resolveObject!: (
      object: Awaited<ReturnType<StorageService["getObject"]>>,
    ) => void;
    const storage = storageWithGetObject(
      vi.fn(
        () =>
          new Promise<Awaited<ReturnType<StorageService["getObject"]>>>(
            (resolve) => {
              resolveObject = resolve;
            },
          ),
      ),
    );
    const hydration = hydrateOutboundAttachment({
      storage,
      companyId: "company-1",
      objectKey: "private/object",
      byteSize: 1,
      sha256: digest(Buffer.from("x")),
      filename: "late.txt",
      mimeType: "text/plain",
      timeoutMs: 25,
    });
    const rejected = expect(hydration).rejects.toMatchObject({
      code: "CHAT_ATTACHMENT_HYDRATION_FAILED",
      message: "Chat publication attachment storage read timed out",
    });

    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    resolveObject({ stream: lateStream, contentLength: 1 });
    await vi.runAllTicks();
    await Promise.resolve();
    await Promise.resolve();

    expect(lateStream.destroyed).toBe(true);
  });

  it("bounds a stream that stalls after returning some bytes", async () => {
    vi.useFakeTimers();
    const stalledStream = new PassThrough();
    const storage = storageWithGetObject(
      vi.fn(async () => ({ stream: stalledStream, contentLength: 2 })),
    );
    const hydration = hydrateOutboundAttachment({
      storage,
      companyId: "company-1",
      objectKey: "private/object",
      byteSize: 2,
      sha256: digest(Buffer.from("xy")),
      filename: "stalled.txt",
      mimeType: "text/plain",
      timeoutMs: 25,
    });
    const rejected = expect(hydration).rejects.toMatchObject({
      code: "CHAT_ATTACHMENT_HYDRATION_FAILED",
      message: "Chat publication attachment storage read timed out",
    });

    stalledStream.write("x");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(stalledStream.destroyed).toBe(true);
  });
});
