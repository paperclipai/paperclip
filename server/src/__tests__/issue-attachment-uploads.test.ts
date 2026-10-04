import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttachmentUploadSpooler } from "../services/issue-attachment-uploads.js";

function fakeRequest(): Request {
  return {} as Request;
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
