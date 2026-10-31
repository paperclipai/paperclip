import { Music } from "lucide-react";
import type { CompanyArtifact } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { glyphOf, isPortrait, kindFor, labelOf, mediaKindOf, subjectFromCompanyArtifact, treatmentOf } from "./kinds";
import { testSubject } from "./test-subject";

describe("treatmentOf", () => {
  it("prints media that has a preview and falls back when it has none", () => {
    expect(treatmentOf(testSubject({ kind: "image", thumbnailUrl: "/cap.png" }))).toBe("media");
    expect(treatmentOf(testSubject({ kind: "video", videoUrl: "/reel.webm" }))).toBe("media");
    expect(treatmentOf(testSubject({ kind: "video" }))).toBe("media-fallback");
    expect(treatmentOf(testSubject({ kind: "file", ext: "mp3" }))).toBe("media-fallback");
  });

  it("previews a document whose text is known and shows the sheet otherwise", () => {
    expect(treatmentOf(testSubject({ kind: "document", hasText: true }))).toBe("preview");
    expect(treatmentOf(testSubject({ kind: "document" }))).toBe("icon");
    expect(treatmentOf(testSubject({ kind: "pdf" }))).toBe("icon");
  });
});

describe("labelOf and glyphOf", () => {
  it("takes the type from the extension, keeps links as URL, draws PDF as bars and audio with the music glyph", () => {
    expect(labelOf(testSubject({ kind: "slides", filename: "deck.pptx" }))).toBe("PPTX");
    expect(labelOf(testSubject({ kind: "link" }))).toBe("URL");
    expect(labelOf(testSubject({ kind: "document" }))).toBe("MD");
    expect(glyphOf(testSubject({ kind: "pdf" }))).toBe("bars");
    expect(glyphOf(testSubject({ kind: "file", ext: "wav" }))).toBe(Music);
  });
});

describe("isPortrait", () => {
  it("stands only prints that are taller than wide; a square lies", () => {
    expect(isPortrait(4 / 5)).toBe(true);
    expect(isPortrait(1)).toBe(false);
    expect(isPortrait(undefined)).toBe(false);
  });
});

describe("mediaKindOf", () => {
  it("follows the server's rule: task documents are Documents, files go by content type", () => {
    expect(mediaKindOf(testSubject({ kind: "document", isTaskDocument: true, contentType: "text/markdown" }))).toBe("document");
    expect(mediaKindOf(testSubject({ kind: "document", filename: "deck-guide.md", contentType: "text/markdown" }))).toBe("text");
    expect(mediaKindOf(testSubject({ kind: "sheet", contentType: "text/csv" }))).toBe("text");
    expect(mediaKindOf(testSubject({ kind: "sheet", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }))).toBe("file");
    expect(mediaKindOf(testSubject({ kind: "image", contentType: "image/png" }))).toBe("image");
    expect(mediaKindOf(testSubject({ kind: "video" }))).toBe("video");
  });
});

describe("kindFor", () => {
  it("names the artwork kind from the extension first and the content type second", () => {
    expect(kindFor("pdf", "application/pdf")).toBe("pdf");
    expect(kindFor("pptx", null)).toBe("slides");
    expect(kindFor("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
    expect(kindFor("md", "text/markdown")).toBe("document");
    expect(kindFor(undefined, "text/html")).toBe("code");
    expect(kindFor("png", "image/png")).toBe("image");
    expect(kindFor(undefined, null, "video")).toBe("video");
    expect(kindFor("otf", "font/otf")).toBe("file");
  });
});

describe("subjectFromCompanyArtifact", () => {
  const base: CompanyArtifact = {
    id: "a1", source: "work_product", mediaKind: "file", title: "Interface Craft deck", previewText: null,
    contentType: "application/pdf", contentPath: "/api/files/acmehats-interface-craft.pdf", openPath: null, downloadPath: null,
    issue: { id: "i1", identifier: "ACM-3", title: "Create visual directions" }, project: null, createdByAgent: null,
    updatedAt: "2026-09-28T11:07:00", href: "/artifacts/a1",
  };

  it("reads the file name and kind from the content path and type", () => {
    const subject = subjectFromCompanyArtifact(base);
    expect(subject).toMatchObject({ kind: "pdf", filename: "acmehats-interface-craft.pdf", ext: "pdf", taskIdentifier: "ACM-3", isTaskDocument: false });
  });

  it("treats a task document as a document with known text when it has a preview", () => {
    const subject = subjectFromCompanyArtifact({ ...base, source: "document", mediaKind: "document", contentType: null, contentPath: null, previewText: "Goal: a clear brand direction" });
    expect(subject).toMatchObject({ kind: "document", isTaskDocument: true, hasText: true, filename: null });
  });

  it("gives pictures and video their content path as the picture", () => {
    const subject = subjectFromCompanyArtifact({ ...base, mediaKind: "image", contentType: "image/png", contentPath: "/api/files/contact-sheet.png" });
    expect(subject).toMatchObject({ kind: "image", thumbnailUrl: "/api/files/contact-sheet.png", filename: "contact-sheet.png" });
    const video = subjectFromCompanyArtifact({ ...base, mediaKind: "video", contentType: "video/webm", contentPath: "/api/files/reel.webm" });
    expect(video).toMatchObject({ kind: "video", videoUrl: "/api/files/reel.webm", thumbnailUrl: null });
  });
});
