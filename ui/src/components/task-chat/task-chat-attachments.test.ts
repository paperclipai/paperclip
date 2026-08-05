import { describe, expect, it } from "vitest";
import {
  extractAttachmentRefs,
  fileKindForName,
  formatFileSize,
  isImageFilename,
} from "./task-chat-attachments";

describe("fileKindForName", () => {
  it("maps known extensions to kind labels", () => {
    expect(fileKindForName("report.pdf").label).toBe("PDF");
    expect(fileKindForName("data.csv").label).toBe("CSV");
    expect(fileKindForName("bundle.zip").label).toBe("ZIP");
    expect(fileKindForName("script.ts").label).toBe("Code");
  });

  it("falls back to File for unknown or missing extensions", () => {
    expect(fileKindForName("mystery.xyz").label).toBe("File");
    expect(fileKindForName("README").label).toBe("File");
  });
});

describe("isImageFilename", () => {
  it("detects image extensions case-insensitively", () => {
    expect(isImageFilename("shot.PNG")).toBe(true);
    expect(isImageFilename("photo.jpeg")).toBe(true);
    expect(isImageFilename("notes.txt")).toBe(false);
  });
});

describe("formatFileSize", () => {
  it("formats byte tiers", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("returns empty for missing or non-positive sizes", () => {
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize(0)).toBe("");
  });
});

describe("extractAttachmentRefs", () => {
  it("extracts attachment links and strips link-only lines", () => {
    const body = "Here are the notes.\n\n[notes.txt](/api/attachments/abc/content) ";
    const { refs, text } = extractAttachmentRefs(body);
    expect(refs).toEqual([{ name: "notes.txt", url: "/api/attachments/abc/content" }]);
    expect(text).toBe("Here are the notes.");
  });

  it("keeps links woven into prose while still chipping them", () => {
    const body = "See [report.pdf](/api/attachments/r1/content) for details.";
    const { refs, text } = extractAttachmentRefs(body);
    expect(refs).toEqual([{ name: "report.pdf", url: "/api/attachments/r1/content" }]);
    expect(text).toBe(body);
  });

  it("ignores image embeds and image-named links", () => {
    const body =
      "![shot.png](/api/attachments/img/content)\n[photo.jpg](/api/attachments/p/content)\n[notes.txt](/api/attachments/n/content)";
    const { refs } = extractAttachmentRefs(body);
    expect(refs).toEqual([{ name: "notes.txt", url: "/api/attachments/n/content" }]);
  });

  it("ignores non-attachment links entirely", () => {
    const body = "[docs](https://example.com/content) and [PAP-1](/issues/PAP-1)";
    const { refs, text } = extractAttachmentRefs(body);
    expect(refs).toEqual([]);
    expect(text).toBe(body);
  });

  it("dedupes repeated references to the same attachment", () => {
    const body =
      "[notes.txt](/api/attachments/n/content)\n[notes.txt](/api/attachments/n/content)";
    const { refs, text } = extractAttachmentRefs(body);
    expect(refs).toHaveLength(1);
    expect(text).toBe("");
  });

  it("unescapes bracket-escaped labels and accepts asset content paths", () => {
    const body = String.raw`[weird \[name\].txt](/api/assets/a1/content?download=1)`;
    const { refs } = extractAttachmentRefs(body);
    expect(refs).toEqual([
      { name: "weird [name].txt", url: "/api/assets/a1/content?download=1" },
    ]);
  });
});
