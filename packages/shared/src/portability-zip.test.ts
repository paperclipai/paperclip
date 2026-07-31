import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  bytesToPortableFileEntry,
  isBlobStorePath,
  readZipArchive,
} from "./portability-zip.js";

// A minimal, faithful zip writer so the node reader can be round-tripped
// against both STORE (method 0) and DEFLATE (method 8) entries. The layout
// matches the browser writer in ui/src/lib/zip.ts: local file headers, then a
// central directory, then the end-of-central-directory record.
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipInput {
  path: string;
  bytes: Uint8Array;
  method?: 0 | 8;
}

function buildZip(entries: ZipInput[], rootPath: string): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 0;
    const fileName = encoder.encode(`${rootPath}/${entry.path}`);
    const checksum = crc32(entry.bytes);
    const body = method === 8 ? deflateRawSync(Buffer.from(entry.bytes)) : Buffer.from(entry.bytes);

    const localHeader = Buffer.alloc(30 + fileName.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(entry.bytes.length, 22);
    localHeader.writeUInt16LE(fileName.length, 26);
    Buffer.from(fileName).copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + fileName.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(entry.bytes.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    Buffer.from(fileName).copy(centralHeader, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);

  return new Uint8Array(Buffer.concat([...localChunks, centralDirectory, eocd]));
}

describe("isBlobStorePath", () => {
  it("matches blobs/ entries at the archive root and under a package root", () => {
    expect(isBlobStorePath("blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStorePath("paperclip-demo/blobs/4f2d1c9a")).toBe(true);
    expect(isBlobStorePath("tasks/pap-1/TASK.md")).toBe(false);
  });
});

describe("bytesToPortableFileEntry", () => {
  it("keeps blobs/ entries as base64 octet streams regardless of extension", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x80, 0xfe, 0xff]);
    expect(bytesToPortableFileEntry("blobs/4f2d1c9a", bytes)).toEqual({
      encoding: "base64",
      data: Buffer.from(bytes).toString("base64"),
      contentType: "application/octet-stream",
    });
  });

  it("decodes valid UTF-8 entries to text and falls back to base64 for invalid bytes", () => {
    const text = new TextEncoder().encode("# Notes\n\ncafé ✅\n");
    expect(bytesToPortableFileEntry("tasks/pap-1/TASK.md", text)).toBe("# Notes\n\ncafé ✅\n");
    const invalid = new Uint8Array([0x68, 0x69, 0xff, 0xfe, 0xc0]);
    expect(bytesToPortableFileEntry("tasks/pap-1/raw", invalid)).toEqual({
      encoding: "base64",
      data: Buffer.from(invalid).toString("base64"),
      contentType: "application/octet-stream",
    });
  });
});

describe("readZipArchive", () => {
  it("round-trips STORE, DEFLATE, and base64 blob entries byte-exactly and strips the shared root", async () => {
    const blobBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x13, 0x37]);
    // A text body large and repetitive enough that DEFLATE actually shrinks it,
    // so the DEFLATE decode path is exercised, not just written.
    const deflated = `# Weekly report\n${"paperclip ".repeat(512)}\n`;

    const archive = buildZip(
      [
        { path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n"), method: 0 },
        { path: "reports/weekly.md", bytes: new TextEncoder().encode(deflated), method: 8 },
        { path: "blobs/4f2d1c9a", bytes: blobBytes, method: 0 },
      ],
      "paperclip-demo",
    );

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "---\nname: Demo\n---\n",
        "reports/weekly.md": deflated,
        "blobs/4f2d1c9a": {
          encoding: "base64",
          data: Buffer.from(blobBytes).toString("base64"),
          contentType: "application/octet-stream",
        },
      },
    });
  });

  it("throws on a truncated archive so a partial upload fails closed", async () => {
    const archive = buildZip(
      [{ path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n") }],
      "paperclip-demo",
    );
    // Chop the tail so a declared entry body runs past the end of the buffer.
    const truncated = archive.slice(0, 40);
    await expect(readZipArchive(truncated)).rejects.toThrow(/truncated|Invalid zip/i);
  });

  it("rejects data-descriptor entries the writer never emits", async () => {
    const archive = buildZip(
      [{ path: "COMPANY.md", bytes: new TextEncoder().encode("hi") }],
      "paperclip-demo",
    );
    // Flip bit 0x0008 in the local header's general-purpose flag (offset 6).
    archive[6] = archive[6]! | 0x08;
    await expect(readZipArchive(archive)).rejects.toThrow(/data descriptors/i);
  });
});
