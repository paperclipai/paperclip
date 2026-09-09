import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import {
  SPILL_BODY_SEPARATOR,
  WAKE_SPILL_MIN_INLINE_CHARS,
  buildSpillPreview,
  estimateSpillNoticeLength,
  formatSpillNotice,
  hasSpillNotice,
  spillContentPath,
  spillWakeText,
  utf8ByteLength,
} from "./wake-output-spill.js";

const { mockAssetCreate, mockAssetRemove, mockAssetGetById, mockLogActivity } = vi.hoisted(() => ({
  mockAssetCreate: vi.fn(),
  mockAssetRemove: vi.fn(),
  mockAssetGetById: vi.fn(),
  mockLogActivity: vi.fn(),
}));

vi.mock("./assets.js", () => ({
  assetService: () => ({
    create: mockAssetCreate,
    remove: mockAssetRemove,
    getById: mockAssetGetById,
  }),
}));

vi.mock("./activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function fakeStorage(impl: {
  putFile?: (body: Buffer) => Promise<{
    provider: "local-disk";
    objectKey: string;
    contentType: string;
    byteSize: number;
    sha256: string;
    originalFilename: string | null;
  }>;
  deleteObject?: (companyId: string, objectKey: string) => Promise<void>;
}): StorageService & { putFileMock: ReturnType<typeof vi.fn>; deleteObjectMock: ReturnType<typeof vi.fn> } {
  const putFileMock = vi.fn(async (input: { body: Buffer }) => {
    if (!impl.putFile) throw new Error("unexpected putFile");
    return impl.putFile(input.body);
  });
  const deleteObjectMock = vi.fn(async (companyId: string, objectKey: string) => {
    await impl.deleteObject?.(companyId, objectKey);
  });
  return {
    provider: "local-disk",
    putFile: putFileMock,
    getObject: async () => { throw new Error("not used"); },
    headObject: async () => { throw new Error("not used"); },
    deleteObject: deleteObjectMock,
    putFileMock,
    deleteObjectMock,
  } as unknown as StorageService & { putFileMock: ReturnType<typeof vi.fn>; deleteObjectMock: ReturnType<typeof vi.fn> };
}

function fakeDb(activityRows: Array<{ entityId: string }> = []) {
  const limit = async () => activityRows;
  const orderBy = () => ({ limit });
  const where = () => ({ orderBy });
  const from = () => ({ where });
  return { select: () => ({ from }) } as unknown as Db;
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    db: fakeDb(),
    companyId: "company-1",
    issueId: "issue-1",
    commentId: "comment-1",
    text: "x".repeat(5_000),
    maxInlineChars: 4_000,
    ...overrides,
  } as Parameters<typeof spillWakeText>[0];
}

function storedFile(body: Buffer, objectKey = "company-1/spill/2026/09/08/spill-abc.txt") {
  return {
    provider: "local-disk" as const,
    objectKey,
    contentType: "text/plain; charset=utf-8",
    byteSize: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
    originalFilename: "spill-abc.txt",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAssetCreate.mockResolvedValue({ id: "12345678-aaaa-bbbb-cccc-123456789abc" });
  mockAssetGetById.mockResolvedValue(null);
  mockLogActivity.mockResolvedValue(undefined);
});

describe("wake output spill", () => {
  it("measures UTF-8 bytes and splits previews head/tail", () => {
    expect(utf8ByteLength("héllo")).toBe(Buffer.byteLength("héllo", "utf8"));
    const text = "a".repeat(3_000) + "b".repeat(3_000);
    const { preview, omittedBytes } = buildSpillPreview(text, 4_000);
    expect(preview.startsWith("a".repeat(1_999))).toBe(true);
    expect(preview.endsWith("b".repeat(1_998))).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(4_000);
    expect(omittedBytes).toBe(2_003);
    const short = buildSpillPreview("tiny", 4_000);
    expect(short).toEqual({ preview: "tiny", omittedBytes: 0 });
  });

  it("keeps surrogate pairs intact while fitting UTF-16 budgets", () => {
    const text = "😀".repeat(5_000);
    const { preview, omittedBytes } = buildSpillPreview(text, 4_000);
    expect(preview).not.toContain("�");
    expect([...preview.replaceAll("\n…\n", "")].length).toBe(1_998);
    expect(preview.length).toBeLessThanOrEqual(4_000);
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

  it("estimates notice length above every real notice", () => {
    const estimate = estimateSpillNoticeLength(12_345_678);
    expect(formatSpillNotice(12_345_678, "12345678-aaaa-bbbb-cccc-123456789abc").length)
      .toBeLessThanOrEqual(estimate);
  });

  it("returns null when text fits, already spilled, or budget is tiny", async () => {
    const storage = fakeStorage({});
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

  it("spills UTF-16-oversized text the caller would truncate", async () => {
    // 4,000 emoji fit the old code-point check but occupy 8,000 UTF-16 units,
    // so the heartbeat caller truncates them. The spill gate must agree.
    const storage = fakeStorage({ putFile: async (body) => storedFile(body) });
    const result = await spillWakeText(baseInput({ text: "😀".repeat(4_000), storage }));
    expect(result).not.toBeNull();
    expect(result!.body.length).toBeLessThanOrEqual(4_000);
  });

  it("stores the full text and keeps the body inside the budget", async () => {
    const text = `line1\n${"y".repeat(6_000)}\nlast-line`;
    const storage = fakeStorage({ putFile: async (body) => storedFile(body) });
    const result = await spillWakeText(
      baseInput({ text, storage, agentId: "agent-1", runId: "run-1" }),
    );
    expect(result).not.toBeNull();
    expect(result!.assetId).toBe("12345678-aaaa-bbbb-cccc-123456789abc");
    expect(result!.contentPath).toBe("/api/assets/12345678-aaaa-bbbb-cccc-123456789abc/content");
    expect(result!.body).toContain("line1");
    expect(result!.body).toContain("last-line");
    expect(result!.body).toContain("bytes omitted");
    expect(result!.body).toContain(result!.contentPath);
    expect(result!.body.length).toBeLessThanOrEqual(4_000);
    expect(mockAssetCreate).toHaveBeenCalledOnce();
    expect(mockLogActivity).toHaveBeenCalledOnce();
    const logged = mockLogActivity.mock.calls[0][1];
    expect(logged).toMatchObject({
      companyId: "company-1",
      action: "asset.created",
      entityId: "12345678-aaaa-bbbb-cccc-123456789abc",
      agentId: "agent-1",
      runId: "run-1",
      issueId: "issue-1",
    });
    expect(logged.details).toMatchObject({ source: "wake_output_spill", commentId: "comment-1" });
    expect(typeof logged.details.sha256).toBe("string");
  });

  it("holds the budget invariant across sizes and scripts", async () => {
    const cases = ["z".repeat(10_000), "é".repeat(10_000), "😀".repeat(10_000), "a😀b".repeat(3_000)];
    for (const text of cases) {
      const storage = fakeStorage({ putFile: async (body) => storedFile(body) });
      const result = await spillWakeText(baseInput({ text, storage }));
      expect(result, text.slice(0, 8)).not.toBeNull();
      expect(result!.body.length).toBeLessThanOrEqual(4_000);
      expect(result!.body).toContain(SPILL_BODY_SEPARATOR);
    }
  });

  it("reuses the existing asset for repeat wakes instead of writing again", async () => {
    const text = "w".repeat(5_000);
    const storage = fakeStorage({ putFile: async (body) => storedFile(body) });
    mockAssetGetById.mockResolvedValue({ id: "asset-old", companyId: "company-1" });
    const input = baseInput({
      text,
      storage,
      db: fakeDb([{ entityId: "asset-old" }]),
    });
    const result = await spillWakeText(input);
    expect(result).not.toBeNull();
    expect(result!.assetId).toBe("asset-old");
    expect(result!.body.length).toBeLessThanOrEqual(4_000);
    expect(storage.putFileMock).not.toHaveBeenCalled();
    expect(mockAssetCreate).not.toHaveBeenCalled();
  });

  it("unwinds the asset row and blob when activity logging fails", async () => {
    const storage = fakeStorage({
      putFile: async (body) => storedFile(body, "company-1/spill/k1.txt"),
    });
    mockLogActivity.mockRejectedValueOnce(new Error("activity down"));
    const result = await spillWakeText(baseInput({ storage }));
    expect(result).toBeNull();
    expect(mockAssetRemove).toHaveBeenCalledWith("12345678-aaaa-bbbb-cccc-123456789abc");
    expect(storage.deleteObjectMock).toHaveBeenCalledWith("company-1", "company-1/spill/k1.txt");
  });

  it("unwinds the blob when the asset row fails", async () => {
    const storage = fakeStorage({
      putFile: async (body) => storedFile(body, "company-1/spill/k2.txt"),
    });
    mockAssetCreate.mockRejectedValueOnce(new Error("db down"));
    const result = await spillWakeText(baseInput({ storage }));
    expect(result).toBeNull();
    expect(mockAssetRemove).not.toHaveBeenCalled();
    expect(storage.deleteObjectMock).toHaveBeenCalledWith("company-1", "company-1/spill/k2.txt");
  });

  it("keeps the original text when storage fails", async () => {
    const storage = fakeStorage({});
    storage.putFileMock.mockRejectedValue(new Error("disk full"));
    expect(await spillWakeText(baseInput({ storage }))).toBeNull();
    expect(mockAssetCreate).not.toHaveBeenCalled();
    expect(storage.deleteObjectMock).not.toHaveBeenCalled();
  });
});
