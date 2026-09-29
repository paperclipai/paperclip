import { crc32 } from "node:zlib";
import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  isTelegramPhoto,
  telegramAttachmentForUpload,
  TELEGRAM_PHOTO_MAX_BYTES,
} from "./chat-telegram-photo.js";

function chunk(type: string, data: Buffer): Buffer {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length);
  output.write(type, 4, "latin1");
  data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, -4)), output.length - 4);
  return output;
}

describe("Telegram bounded photo selection", () => {
  let png: Buffer;
  let jpeg: Buffer;
  beforeAll(async () => {
    const input = {
      create: {
        width: 20,
        height: 10,
        channels: 3 as const,
        background: "#e08040",
      },
    };
    png = await sharp(input).png().toBuffer();
    jpeg = await sharp(input).jpeg().toBuffer();
  });

  it.each([
    "png",
    "jpeg",
    "progressive_jpeg",
    "interlaced_png",
    "indexed_png",
  ] as const)("retains valid ordinary %s as a photo", async (mode) => {
    const input = sharp({
      create: { width: 20, height: 10, channels: 3, background: "#e08040" },
    });
    const bytes =
      mode === "png"
        ? png
        : mode === "jpeg"
          ? jpeg
          : mode === "progressive_jpeg"
            ? await input.jpeg({ progressive: true }).toBuffer()
            : await input
                .png(
                  mode === "interlaced_png"
                    ? { progressive: true }
                    : { palette: true },
                )
                .toBuffer();
    const mime = mode.includes("jpeg") ? "image/jpeg" : "image/png";
    expect(isTelegramPhoto(bytes, mime)).toBe(true);
  });

  it.each(["Buffer", "ArrayBuffer", "Blob"] as const)(
    "preserves exact %s bytes and MIME parameters in either lane",
    async (kind) => {
      for (const bytes of [png, png.subarray(0, 20)]) {
        const data =
          kind === "Buffer"
            ? bytes
            : kind === "Blob"
              ? new Blob([new Uint8Array(bytes)])
              : new Uint8Array(bytes).buffer;
        const result = await telegramAttachmentForUpload({
          data,
          filename: "original.png",
          mimeType: "IMAGE/PNG; charset=binary",
        });
        expect(result).toMatchObject({
          type: bytes === png ? "image" : "file",
          name: "original.png",
          size: bytes.length,
          mimeType: "image/png; charset=binary",
        });
        const output =
          result.data instanceof Blob
            ? Buffer.from(await result.data.arrayBuffer())
            : Buffer.from(result.data as Uint8Array);
        expect(output).toEqual(bytes);
        if (kind !== "ArrayBuffer") expect(result.data).toBe(data);
      }
    },
  );

  it("does not materialize an oversized Blob for metadata inspection", async () => {
    const blob = new Blob([Buffer.alloc(TELEGRAM_PHOTO_MAX_BYTES + 1)]);
    const read = vi.spyOn(blob, "arrayBuffer");
    expect(
      await telegramAttachmentForUpload({
        data: blob,
        filename: "large.png",
        mimeType: "image/png",
      }),
    ).toMatchObject({ type: "file", data: blob, size: blob.size });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects format mismatch and non-photo formats without changing data", async () => {
    for (const mime of [
      "image/jpeg",
      "image/gif",
      "image/webp",
      "image/svg+xml",
      "image/unknown",
    ]) {
      expect(isTelegramPhoto(png, mime)).toBe(false);
      expect(
        await telegramAttachmentForUpload({
          data: png,
          filename: "original",
          mimeType: mime,
        }),
      ).toMatchObject({ type: "file", data: png });
    }
    expect(isTelegramPhoto(jpeg, "image/jpg")).toBe(true);
  });

  it("refuses every truncated PNG and JPEG prefix without throwing", () => {
    for (const [bytes, mime] of [
      [png, "image/png"],
      [jpeg, "image/jpeg"],
    ] as const) {
      for (let size = 0; size < bytes.length; size += 1)
        expect(isTelegramPhoto(bytes.subarray(0, size), mime)).toBe(false);
    }
  });

  it("rejects PNG CRC, high-bit type, oversized length and duplicate/animated headers", () => {
    const corruptCrc = Buffer.from(png);
    corruptCrc[29] = corruptCrc[29]! ^ 1;
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(0xffffffff, 8);
    const ihdr = Buffer.from(png.subarray(16, 29));
    const invalidGeometry = Buffer.from(ihdr);
    invalidGeometry.writeUInt32BE(0xffffffff);
    const badDepth = Buffer.from(ihdr);
    badDepth[8] = 3;
    const variants = [
      corruptCrc,
      oversized,
      Buffer.concat([
        png.subarray(0, 8),
        chunk("\xc9HDR", ihdr),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 8),
        chunk("IHDR", invalidGeometry),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 8),
        chunk("IHDR", badDepth),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 33),
        chunk("IHDR", ihdr),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 33),
        chunk("acTL", Buffer.alloc(8)),
        png.subarray(33),
      ]),
      Buffer.concat([png, Buffer.from("trailing")]),
    ];
    for (const bytes of variants)
      expect(isTelegramPhoto(bytes, "image/png")).toBe(false);
  });

  it("bounds PNG part count and JPEG metadata/fill scanning without decoding", () => {
    const manyChunks = Buffer.concat([
      png.subarray(0, 33),
      ...Array.from({ length: 4096 }, () => chunk("tEXt", Buffer.from("k\0v"))),
      png.subarray(33),
    ]);
    expect(isTelegramPhoto(manyChunks, "image/png")).toBe(false);
    const app = Buffer.alloc(65_537);
    app.writeUInt16BE(0xffe1);
    app.writeUInt16BE(65_535, 2);
    const hugeHeader = Buffer.concat([
      jpeg.subarray(0, 2),
      app,
      app,
      app,
      app,
      jpeg.subarray(2),
    ]);
    expect(isTelegramPhoto(hugeHeader, "image/jpeg")).toBe(false);
    const fillFlood = Buffer.alloc(TELEGRAM_PHOTO_MAX_BYTES, 0xff);
    fillFlood.writeUInt16BE(0xffd8);
    fillFlood.writeUInt16BE(0xffd9, fillFlood.length - 2);
    expect(isTelegramPhoto(fillFlood, "image/jpeg")).toBe(false);
  });

  it("rejects impossible JPEG segment lengths and frame dimensions", () => {
    const tooShort = Buffer.from(jpeg);
    tooShort.writeUInt16BE(1, 4);
    const beyondFile = Buffer.from(jpeg);
    beyondFile.writeUInt16BE(0xffff, 4);
    const invalidFrame = Buffer.from(jpeg);
    const frame = invalidFrame.indexOf(Buffer.from([0xff, 0xc0]));
    expect(frame).toBeGreaterThan(0);
    invalidFrame.writeUInt16BE(0, frame + 7);
    for (const bytes of [tooShort, beyondFile, invalidFrame])
      expect(isTelegramPhoto(bytes, "image/jpeg")).toBe(false);
  });

  it.each([
    "unknown_scan_component",
    "zero_sampling",
    "duplicate_frame_component",
  ] as const)(
    "refuses an impossible JPEG component descriptor (%s)",
    async (mode) => {
      const bytes = Buffer.from(jpeg);
      const frame = bytes.indexOf(Buffer.from([0xff, 0xc0]));
      const scan = bytes.indexOf(Buffer.from([0xff, 0xda]));
      expect(frame).toBeGreaterThan(0);
      expect(scan).toBeGreaterThan(frame);
      if (mode === "unknown_scan_component") bytes[scan + 5] = 99;
      else if (mode === "zero_sampling") bytes[frame + 11] = 0;
      else bytes[frame + 13] = bytes[frame + 10]!;
      await expect(sharp(bytes).raw().toBuffer()).rejects.toThrow();
      expect(isTelegramPhoto(bytes, "image/jpeg")).toBe(false);
      expect(
        await telegramAttachmentForUpload({
          data: bytes,
          filename: "original.jpg",
          mimeType: "image/jpeg",
        }),
      ).toMatchObject({ type: "file", data: bytes });
    },
  );

  it("returns a bounded no-throw refusal for deterministic random buffers", () => {
    let state = 0x12345678;
    for (let size = 0; size < 4096; size += 7) {
      const bytes = Buffer.alloc(size);
      for (let index = 0; index < size; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        bytes[index] = state & 255;
      }
      expect(isTelegramPhoto(bytes, "image/png")).toBe(false);
      expect(isTelegramPhoto(bytes, "image/jpeg")).toBe(false);
    }
  });
});
