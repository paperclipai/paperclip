import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { ReadStream } from "node:fs";
import { readdirSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApp,
  createStorageService,
  makeAttachment,
  mockAccessService,
  mockIssueService,
  registerRouteMocks,
} from "./issue-attachment-route-harness.js";

/**
 * Large-media uploads (AI-568).
 *
 * The issue attachment route spools to disk so a rendered video deliverable
 * never lands on the Node heap. These cover the properties that make that safe:
 * the object arrives complete, storage gets a stream, and no spool directory
 * survives any exit path.
 */
describe("issue attachment large media", () => {
  const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
  let spoolHome = "";
  let previousHome: string | undefined;
  let previousInstance: string | undefined;

  function spoolRoot(): string {
    return path.join(
      spoolHome,
      "instances",
      "issue-attachment-large-media",
      "data",
      "attachment-uploads",
    );
  }

  function spoolLeftovers(): string[] {
    try {
      return readdirSync(spoolRoot());
    } catch {
      return [];
    }
  }

  /**
   * The response is written before the handler's `finally` releases the spool, so
   * a client can observe the response while the directory still exists. Poll
   * rather than assert instantly — this checks that cleanup happens, not that it
   * happens before the response is flushed.
   */
  async function waitForSpoolEmpty(timeoutMs = 5_000): Promise<string[]> {
    const deadline = Date.now() + timeoutMs;
    let leftovers = spoolLeftovers();
    while (leftovers.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      leftovers = spoolLeftovers();
    }
    return leftovers;
  }

  /** Deterministic pseudo-random bytes, so a digest mismatch is a real signal. */
  function makeVideoBytes(byteSize: number): Buffer {
    const body = Buffer.alloc(byteSize);
    let state = 0x2f6e2b1;
    for (let i = 0; i < byteSize; i += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      body[i] = state & 0xff;
    }
    return body;
  }

  beforeAll(async () => {
    spoolHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-issue-attach-"));
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
    // The spooler resolves the instance root when the route module is built.
    process.env.PAPERCLIP_HOME = spoolHome;
    process.env.PAPERCLIP_INSTANCE_ID = "issue-attachment-large-media";
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await fs.rm(spoolHome, { recursive: true, force: true });
    vi.resetModules();
  });

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("@paperclipai/shared/telemetry");
    vi.doUnmock("../telemetry.js");
    vi.doUnmock("../services/issues.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/activity-log.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      explanation: "Allowed by test mock",
    });
    mockIssueService.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: "company-1",
      identifier: "PAP-1",
    });
  });

  it("attaches a 70 MB video in one call and streams it to storage", async () => {
    const bytes = makeVideoBytes(70 * 1024 * 1024);
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const storage = createStorageService();
    mockIssueService.createAttachment.mockResolvedValue(
      makeAttachment("video/mp4", "episode-2.mp4"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/companies/company-1/issues/${ISSUE_ID}/attachments`)
      .attach("file", bytes, { filename: "episode-2.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(201);

    const putFileCall = storage.__calls.putFile;
    // A stream, not a 70 MB heap buffer: that is the whole point of the change.
    expect(Buffer.isBuffer(putFileCall?.body as Buffer)).toBe(false);
    expect(typeof (putFileCall?.body as Readable | undefined)?.pipe).toBe("function");
    expect(putFileCall?.byteSize).toBe(bytes.length);
    // The digest comes from a disk read of the spool, not from the heap buffer.
    expect(putFileCall?.sha256).toBe(expectedSha);

    // The mock read the streamed body to completion, so this proves the whole
    // file arrived — not merely that storage was handed a stream argument.
    const received = storage.__calls.receivedBytes;
    expect(received?.length).toBe(bytes.length);
    expect(createHash("sha256").update(received ?? Buffer.alloc(0)).digest("hex")).toBe(expectedSha);
    // Storage's computed size and digest flow through to the attachment row.
    expect(mockIssueService.createAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ byteSize: bytes.length, sha256: expectedSha }),
    );

    // No spool directory survives the success path.
    expect(await waitForSpoolEmpty()).toEqual([]);
  }, 120_000);

  it("closes the spool reader when storage rejects before reading the body", async () => {
    // Storage can reject before it touches the stream — for example an invalid
    // generated object key. The route must still destroy the reader, or the
    // unlinked spool file's blocks stay pinned by the open descriptor.
    const storage = createStorageService(Buffer.from("test"), {
      putFileError: new Error("object key rejected before read"),
    });
    mockIssueService.createAttachment.mockResolvedValue(
      makeAttachment("video/mp4", "a..b.mp4"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/companies/company-1/issues/${ISSUE_ID}/attachments`)
      .attach("file", makeVideoBytes(64 * 1024), {
        filename: "a..b.mp4",
        contentType: "video/mp4",
      });

    expect(res.status).toBe(500);
    const body = storage.__calls.putFile?.body as ReadStream | undefined;
    expect(body).toBeDefined();
    expect(body?.destroyed).toBe(true);
    expect(await waitForSpoolEmpty()).toEqual([]);
  });

  it("rejects an empty upload and leaves no spool", async () => {
    const storage = createStorageService();
    mockIssueService.createAttachment.mockResolvedValue(
      makeAttachment("video/mp4", "empty.mp4"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/companies/company-1/issues/${ISSUE_ID}/attachments`)
      .attach("file", Buffer.alloc(0), { filename: "empty.mp4", contentType: "video/mp4" });

    expect(res.status).toBe(422);
    expect(storage.__calls.putFile).toBeUndefined();
    expect(await waitForSpoolEmpty()).toEqual([]);
  });

  it("rejects an upload with 429 once the aggregate spool budget is exhausted", async () => {
    // The per-request ceiling bounds one upload; the aggregate budget is what
    // stops N concurrent ones from filling the instance volume.
    const previous = process.env.PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES;
    process.env.PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES = "1024";
    try {
      const storage = createStorageService();
      mockIssueService.createAttachment.mockResolvedValue(
        makeAttachment("video/mp4", "episode-3.mp4"),
      );

      const app = await createApp(storage);
      const res = await request(app)
        .post(`/api/companies/company-1/issues/${ISSUE_ID}/attachments`)
        .attach("file", makeVideoBytes(64 * 1024), {
          filename: "episode-3.mp4",
          contentType: "video/mp4",
        });

      expect(res.status).toBe(429);
      expect(res.headers["retry-after"]).toBeTruthy();
      expect(String(res.body.error)).toContain("upload capacity is busy");
      // Refused before any byte reached storage or disk.
      expect(storage.__calls.putFile).toBeUndefined();
      expect(await waitForSpoolEmpty()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES;
      else process.env.PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES = previous;
      vi.resetModules();
    }
  });

  it("leaves no spool when attachment registration is rejected", async () => {
    const storage = createStorageService();
    const { HttpError } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
    mockIssueService.createAttachment.mockRejectedValue(
      new HttpError(422, "Comment does not belong to issue"),
    );

    const app = await createApp(storage);
    const res = await request(app)
      .post(`/api/companies/company-1/issues/${ISSUE_ID}/attachments`)
      .attach("file", makeVideoBytes(64 * 1024), {
        filename: "rejected.mp4",
        contentType: "video/mp4",
      });

    expect(res.status).toBe(422);
    // A 4xx registration rejection deletes the just-written object...
    expect(storage.deleteObject).toHaveBeenCalled();
    // ...and the spool is released on that throw path too.
    expect(await waitForSpoolEmpty()).toEqual([]);
  });
});
