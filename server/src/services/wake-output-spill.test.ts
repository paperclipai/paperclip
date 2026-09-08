import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import {
  WAKE_SPILL_MIN_INLINE_CHARS,
  buildSpillPreview,
  formatSpillNotice,
  hasSpillNotice,
  spillContentPath,
  spillWakeText,
  utf8ByteLength,
} from "./wake-output-spill.js";

const { mockAssetCreate, mockLogActivity } = vi.hoisted(() => ({
  mockAssetCreate: vi.fn(),
  mockLogActivity: vi.fn(),
}));

vi.mock("./assets.js", () => ({
  assetService: () => ({ create: mockAssetCreate }),
}));

vi.mock("./activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function fakeStorage(putFile: (body: Buffer) => Promise<never> | Promise<{
  provider: "local-disk";
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
}>): StorageService {
  return {
    provider: "local-disk",
    putFile: async (input: { body: Buffer; contentType: string; companyId: string; namespace: string; originalFilename: string | null }) =>
      putFile(input.body),
    getObject: async () => { throw new Error("not used"); },
    headObject: async () => { throw new Error("not used"); },
    deleteObject: async () => {},
  } as unknown as StorageService;
}

const db = {} as unknown as Db;

function baseInput(overrides: Partial<Parameters<typeof spillWakeText>[0]> = {}) {
  return {
    db,
    companyId: "company-1",
    issueId: "issue-1",
    commentId: "comment-1",
    text: "x".repeat(5_000),
    maxInlineChars: 4_000,
    ...overrides,
  };
}

describe("wake output spill", () => {
  it("measures UTF-8 bytes and splits previews head/tail", () => {
    expect(utf8ByteLength("héllo")).toBe(Buffer.byteLength("héllo", "utf8"));
    const text = "a".repeat(3_000) + "b".repeat(3_000);
    const { preview, omittedBytes } = buildSpillPreview(text, 4_000);
    expect(preview.startsWith("a".repeat(2_000))).toBe(true);
    expect(preview.endsWith("b".repeat(2_000))).toBe(true);
    expect(omittedBytes).toBe(2_000);
    const short = buildSpillPreview("tiny", 4_000);
    expect(short).toEqual({ preview: "tiny", omittedBytes: 0 });
  });

  it("keeps surrogate pairs intact across the split", () => {
    const text = "😀".repeat(5_000);
    const { preview, omittedBytes } = buildSpillPreview(text, 4_000);
    expect(preview).not.toContain("�");
    expect([...preview.replaceAll("\n…\n", "")].length).toBe(4_000);
    expect(omittedBytes).toBeGreaterThan(0);
  });

  it("formats and recognizes its own notice", () => {
    const notice = formatSpillNotice(12_345, "asset-1");
    expect(notice).toContain("12345 bytes omitted");
    expect(notice).toContain(spillContentPath("asset-1"));
    expect(hasSpillNotice(`preview\n\n${notice}`)).toBe(true);
    expect(hasSpillNotice("plain text")).toBe(false);
    expect(hasSpillNotice("ends with ) but no locator")).toBe(false);
  });

  it("returns null when text fits, already spilled, or budget is tiny", async () => {
    const storage = fakeStorage(async () => { throw new Error("must not store"); });
    expect(await spillWakeText(baseInput({ text: "short", storage }))).toBeNull();
    const notice = formatSpillNotice(100, "asset-9");
    expect(
      await spillWakeText(baseInput({ text: `preview\n\n${notice}`, storage })),
    ).toBeNull();
    expect(
      await spillWakeText(
        baseInput({ text: "x".repeat(500), maxInlineChars: 100, storage }),
      ),
    ).toBeNull();
    expect(WAKE_SPILL_MIN_INLINE_CHARS).toBe(256);
  });

  it("stores the full text and returns preview plus notice", async () => {
    const text = `line1\n${"y".repeat(6_000)}\nlast-line`;
    mockAssetCreate.mockResolvedValueOnce({ id: "asset-7" });
    const storage = fakeStorage(async (body) => ({
      provider: "local-disk" as const,
      objectKey: "company-1/spill/spill-comment-comment-1.txt",
      contentType: "text/plain; charset=utf-8",
      byteSize: body.length,
      sha256: "abc",
      originalFilename: "spill-comment-comment-1.txt",
    }));
    const result = await spillWakeText(
      baseInput({ text, storage, agentId: "agent-1", runId: "run-1" }),
    );
    expect(result).not.toBeNull();
    expect(result!.assetId).toBe("asset-7");
    expect(result!.contentPath).toBe("/api/assets/asset-7/content");
    expect(result!.body).toContain("line1");
    expect(result!.body).toContain("last-line");
    expect(result!.body).toContain("bytes omitted");
    expect(result!.body).toContain(result!.contentPath);
    expect(mockAssetCreate).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledOnce();
    const logged = mockLogActivity.mock.calls[0][1];
    expect(logged).toMatchObject({
      companyId: "company-1",
      action: "asset.created",
      entityId: "asset-7",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
    });
  });

  it("keeps the original text when storage fails", async () => {
    mockAssetCreate.mockClear();
    mockLogActivity.mockClear();
    const storage = fakeStorage(async () => { throw new Error("disk full"); });
    expect(await spillWakeText(baseInput({ storage }))).toBeNull();
    expect(mockAssetCreate).not.toHaveBeenCalled();
  });

  it("keeps the original text when the asset row is missing", async () => {
    mockAssetCreate.mockResolvedValueOnce(null);
    const storage = fakeStorage(async (body) => ({
      provider: "local-disk" as const,
      objectKey: "k",
      contentType: "text/plain; charset=utf-8",
      byteSize: body.length,
      sha256: "abc",
      originalFilename: "spill.txt",
    }));
    expect(await spillWakeText(baseInput({ storage }))).toBeNull();
  });
});
