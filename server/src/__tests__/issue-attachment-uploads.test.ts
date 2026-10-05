import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachmentUploadSpooler } from "../services/issue-attachment-uploads.js";

function fakeRequest(contentLength?: number): Request {
  return {
    headers: contentLength === undefined ? {} : { "content-length": String(contentLength) },
  } as unknown as Request;
}

/** A minimal `Response.once("close")` sink for the admission backstop. */
function fakeResponse(): { once: (event: string, cb: () => void) => void } {
  return { once: () => undefined };
}

describe("attachment upload spooler", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-spool-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates a per-request directory and releases it", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    const req = fakeRequest();

    const dir = await new Promise<string>((resolve, reject) => {
      spooler.destination(req, {}, (err, value) => (err ? reject(err) : resolve(value)));
    });

    expect(path.dirname(dir)).toBe(path.resolve(root));
    await fs.writeFile(path.join(dir, "upload"), "bytes");
    expect(await fs.readdir(root)).toEqual([path.basename(dir)]);

    // `req.file.path` is `<dir>/upload`, which is how the route hands cleanup over.
    (req as Request & { file?: unknown }).file = { path: path.join(dir, "upload") };
    await spooler.release(req);

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("releases the directory even when multer aborted before setting req.file", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    const req = fakeRequest();

    const dir = await new Promise<string>((resolve, reject) => {
      spooler.destination(req, {}, (err, value) => (err ? reject(err) : resolve(value)));
    });
    await fs.writeFile(path.join(dir, "upload"), "partial bytes");

    await spooler.release(req);

    expect(await fs.readdir(root)).toEqual([]);
  });

  it("release is a no-op for an unknown request", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    await expect(spooler.release(fakeRequest())).resolves.toBeUndefined();
  });

  it("ignores a file path outside the spool root", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    const outside = path.join(os.tmpdir(), `paperclip-spool-escape-${process.pid}`);
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "upload"), "keep me");

    const req = fakeRequest();
    (req as Request & { file?: unknown }).file = { path: path.join(outside, "upload") };
    await spooler.release(req);

    expect(await fs.readdir(outside)).toEqual(["upload"]);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("sweeps orphan directories but not in-flight ones", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    const old = path.join(root, "old-upload");
    const fresh = path.join(root, "fresh-upload");
    await fs.mkdir(old, { recursive: true });
    await fs.mkdir(fresh, { recursive: true });
    await fs.writeFile(path.join(old, "upload"), "orphan");
    await fs.writeFile(path.join(fresh, "upload"), "in flight");
    // Age the orphan past the 24h threshold; leave the in-flight dir alone.
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(old, twoDaysAgo, twoDaysAgo);

    const removed = await spooler.sweepOrphans();

    expect(removed).toEqual([old]);
    expect(await fs.readdir(root)).toEqual(["fresh-upload"]);
  });

  it("sweep is safe when the root does not exist yet", async () => {
    const spooler = createAttachmentUploadSpooler(path.join(root, "not-created"));
    await expect(spooler.sweepOrphans()).resolves.toEqual([]);
  });
});

/**
 * A per-request ceiling does not bound N concurrent requests. Without an
 * aggregate budget an authorized caller can start enough large uploads to pin
 * the volume that also holds the instance database, so the budget is reserved
 * before multer writes and released with the spool.
 */
describe("attachment upload spool budget", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-spool-budget-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("reserves the declared content length and frees it on release", async () => {
    const spooler = createAttachmentUploadSpooler(root, { maxInFlightBytes: 1_000 });
    const req = fakeRequest(400);

    const admitted = spooler.admit(req, fakeResponse() as never);
    expect(admitted.admitted).toBe(true);
    expect(spooler.inFlightBytes).toBe(400);
    expect(spooler.maxInFlightBytes).toBe(1_000);

    await spooler.release(req);
    expect(spooler.inFlightBytes).toBe(0);
  });

  it("admits concurrent uploads up to the budget and rejects the one that overflows it", async () => {
    const spooler = createAttachmentUploadSpooler(root, { maxInFlightBytes: 1_000 });
    const first = fakeRequest(700);
    const second = fakeRequest(700);

    expect(spooler.admit(first, fakeResponse() as never).admitted).toBe(true);
    const rejected = spooler.admit(second, fakeResponse() as never);
    expect(rejected.admitted).toBe(false);
    if (rejected.admitted) throw new Error("unreachable");
    expect(rejected.inFlightBytes).toBe(700);
    expect(rejected.maxInFlightBytes).toBe(1_000);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);

    // A rejected request reserved nothing, so it leaves no spool behind.
    expect(await fs.readdir(root)).toEqual([]);

    await spooler.release(first);
    expect(spooler.inFlightBytes).toBe(0);
    expect(spooler.admit(second, fakeResponse() as never).admitted).toBe(true);
  });

  it("reserves the per-request ceiling when the request declares no length", async () => {
    // A chunked request has no declared length to trust, so it reserves the
    // ceiling: over-reserving only delays the next upload, under-reserving
    // would let unbounded spool usage through.
    const spooler = createAttachmentUploadSpooler(root);
    expect(spooler.maxInFlightBytes).toBe(512 * 1024 * 1024);
    expect(spooler.admit(fakeRequest(), fakeResponse() as never).admitted).toBe(true);
    expect(spooler.inFlightBytes).toBe(512 * 1024 * 1024);
  });

  it("admitting the same request twice is idempotent", async () => {
    const spooler = createAttachmentUploadSpooler(root, { maxInFlightBytes: 1_000 });
    const req = fakeRequest(400);

    spooler.admit(req, fakeResponse() as never);
    spooler.admit(req, fakeResponse() as never);
    expect(spooler.inFlightBytes).toBe(400);

    await spooler.release(req);
    expect(spooler.inFlightBytes).toBe(0);
  });

  it("frees the reservation when the response closes before the handler finishes", async () => {
    const spooler = createAttachmentUploadSpooler(root, { maxInFlightBytes: 1_000 });
    let onClose: (() => void) | undefined;
    const response = {
      once: (event: string, cb: () => void) => {
        if (event === "close") onClose = cb;
      },
    };
    const req = fakeRequest(900);

    spooler.admit(req, response as never);
    expect(spooler.inFlightBytes).toBe(900);

    // The handler's `finally` never ran (aborted mid-upload); the backstop that
    // `admit` registered on the response is what stops the budget leaking.
    onClose?.();
    expect(spooler.inFlightBytes).toBe(0);
  });
});

/**
 * The sweep used to infer liveness from the spool directory's mtime, but an
 * mtime does not advance while the file inside it is written or read. A long
 * upload could therefore be reaped underneath an active request.
 */
describe("attachment upload spool sweep liveness", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-spool-sweep-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never reaps a directory that is still in flight, however old it looks", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    const req = fakeRequest();
    const dir = await new Promise<string>((resolve, reject) => {
      spooler.destination(req, {}, (err, value) => (err ? reject(err) : resolve(value)));
    });
    await fs.writeFile(path.join(dir, "upload"), "in flight");
    // A directory written to once keeps a stale mtime for the whole upload.
    const longAgo = new Date(Date.now() - 72 * 60 * 60 * 1000);
    await fs.utimes(dir, longAgo, longAgo);

    expect(await spooler.sweepOrphans()).toEqual([]);
    expect(await fs.readdir(dir)).toEqual(["upload"]);

    // Once released it is an orphan like any other, and the sweep reclaims it.
    await spooler.release(req);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reclaims a spool directory left behind by a failed cleanup", async () => {
    const spooler = createAttachmentUploadSpooler(root);
    const leftover = path.join(root, "leftover");
    await fs.mkdir(leftover, { recursive: true });
    await fs.writeFile(path.join(leftover, "upload"), "orphaned bytes");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(leftover, old, old);

    expect(await spooler.sweepOrphans()).toEqual([leftover]);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
