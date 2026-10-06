import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { GENERIC_ATTACHMENT_CONTENT_TYPES } from "../attachment-types.js";
import { identifyTeamsImage, teamsImageNeedsIdentification } from "./chat-teams-image-type.js";

describe("Teams generic image metadata", () => {
  it.each(GENERIC_ATTACHMENT_CONTENT_TYPES)("identifies image candidates with %s metadata", (mimeType) => {
    for (const name of ["picture.png", "photo.JPG", "photo.HEIC", "image.webp", "image.gif", "image.heif"]) {
      expect(teamsImageNeedsIdentification({ name, mimeType })).toBe(true);
    }
  });

  it.each(["payload.exe", "image.svg", "file", "image.png.exe"])("does not widen generic uploads: %s", (name) => {
    expect(teamsImageNeedsIdentification({ name, mimeType: "application/octet-stream" })).toBe(false);
  });

  it.each(["application/x-executable", "image/svg+xml", "image/avif"])("does not reinterpret an explicitly unsupported MIME: %s", (mimeType) => {
    expect(teamsImageNeedsIdentification({ name: "photo.png", mimeType })).toBe(false);
  });

  it("accepts wildcard image candidates without a filename but not unnamed generic files", () => {
    expect(teamsImageNeedsIdentification({ mimeType: "image/*" })).toBe(true);
    expect(teamsImageNeedsIdentification({ name: "", mimeType: "application/octet-stream" })).toBe(false);
    expect(teamsImageNeedsIdentification({ name: "photo.PNG", mimeType: " APPLICATION/OCTET-STREAM; charset=binary " })).toBe(true);
  });

  it.each(["png", "jpeg", "webp", "gif"] as const)("identifies actual %s bytes", async (format) => {
    const body = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).toFormat(format).toBuffer();
    expect(await identifyTeamsImage(body)).toBe(`image/${format}`);
  });

  it.each([Buffer.from("not an image"), Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'/>")])(
    "rejects invalid or unsupported bytes",
    async (body) => expect(await identifyTeamsImage(body)).toBeNull(),
  );

  it("identifies the existing synthetic HEIC fixture", async () => {
    const body = await readFile(new URL("../__tests__/photon/fixtures/synthetic.heic", import.meta.url));
    expect(await identifyTeamsImage(body)).toBe("image/heic");
  });

  it("does not relabel an unsupported AVIF image as HEIC", async () => {
    const body = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).avif().toBuffer();
    expect(await identifyTeamsImage(body)).toBeNull();
  });

  it("rejects a valid PNG above the 40-megapixel bound", async () => {
    const body = await sharp({ create: { width: 8_000, height: 5_001, channels: 3, background: "white" } }).png().toBuffer();
    expect(await identifyTeamsImage(body)).toBeNull();
  });
});
