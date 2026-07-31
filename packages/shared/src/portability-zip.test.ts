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

  // Locate the first central-directory file header so a test can lop off the
  // whole directory + EOCD, leaving only intact local entries.
  function centralDirectoryOffset(archive: Uint8Array): number {
    for (let i = 0; i + 4 <= archive.length; i += 1) {
      if (archive[i] === 0x50 && archive[i + 1] === 0x4b && archive[i + 2] === 0x01 && archive[i + 3] === 0x02) {
        return i;
      }
    }
    return -1;
  }

  it("rejects an archive truncated before the central directory", async () => {
    const archive = buildZip(
      [
        { path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n") },
        { path: "agents/ceo/AGENTS.md", bytes: new TextEncoder().encode("---\nname: CEO\n---\n") },
      ],
      "paperclip-demo",
    );
    // Keep every local entry intact but drop the directory + EOCD, mimicking an
    // upload cut at a record boundary. The reader must not import the fragment.
    const withoutDirectory = archive.slice(0, centralDirectoryOffset(archive));
    await expect(readZipArchive(withoutDirectory)).rejects.toThrow(/truncated before the central directory/i);
  });

  it("rejects an archive whose end-of-central-directory record is missing", async () => {
    const archive = buildZip(
      [{ path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n") }],
      "paperclip-demo",
    );
    // The central directory survives but the trailing 22-byte EOCD is gone.
    await expect(readZipArchive(archive.slice(0, archive.length - 22))).rejects.toThrow(
      /end-of-central-directory/i,
    );
  });

  it("rejects an archive whose central directory count does not match the entries read", async () => {
    const archive = buildZip(
      [{ path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n") }],
      "paperclip-demo",
    );
    // Overstate the total-entries field (EOCD offset +10 → last 12 bytes in) so a
    // silently-dropped central-directory record is caught.
    archive[archive.length - 12] = 5;
    archive[archive.length - 11] = 0;
    await expect(readZipArchive(archive)).rejects.toThrow(/central directory declares 5 entries/i);
  });

  it("rejects a truncated archive re-terminated with a forged EOCD that matches the surviving entries", async () => {
    // The exact silent-partial-import this reader guards against: an archive is
    // cut after a complete leading local entry (losing the real central directory
    // and EOCD), then re-terminated with a hand-forged 22-byte EOCD whose entry
    // count matches the surviving local entry. An entry-count-only check would
    // wave it through; validating the central directory it points at must not.
    const archive = buildZip(
      [{ path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n") }],
      "paperclip-demo",
    );
    // Keep only the intact local entry (everything before the first central record).
    const localOnly = archive.slice(0, centralDirectoryOffset(archive));

    const forgedEocd = Buffer.alloc(22);
    forgedEocd.writeUInt32LE(0x06054b50, 0);
    forgedEocd.writeUInt16LE(1, 8); // entries on this disk
    forgedEocd.writeUInt16LE(1, 10); // total entries — matches the one surviving local entry
    forgedEocd.writeUInt32LE(0, 12); // central directory size (forged)
    forgedEocd.writeUInt32LE(0, 16); // central directory offset (forged)
    const forged = new Uint8Array(Buffer.concat([Buffer.from(localOnly), forgedEocd]));

    await expect(readZipArchive(forged)).rejects.toThrow(/central directory location is inconsistent/i);
  });

  it("rejects a forged EOCD whose central directory offset points at non-directory bytes", async () => {
    const archive = buildZip(
      [{ path: "COMPANY.md", bytes: new TextEncoder().encode("---\nname: Demo\n---\n") }],
      "paperclip-demo",
    );
    const firstEntryOnly = archive.slice(0, centralDirectoryOffset(archive));
    // A forged EOCD whose offset+size abut the record (passing the location
    // check) but point into the local entry, which carries no directory signature.
    const forgedEocd = Buffer.alloc(22);
    forgedEocd.writeUInt32LE(0x06054b50, 0);
    forgedEocd.writeUInt16LE(1, 8);
    forgedEocd.writeUInt16LE(1, 10);
    forgedEocd.writeUInt32LE(46, 12); // size
    forgedEocd.writeUInt32LE(firstEntryOnly.length - 46, 16); // start = eocdOffset - size
    const forged = new Uint8Array(Buffer.concat([Buffer.from(firstEntryOnly), forgedEocd]));

    await expect(readZipArchive(forged)).rejects.toThrow(/malformed central directory record/i);
  });

  it("rejects two entries that normalize to the same path instead of silently overwriting", async () => {
    const archive = buildZip(
      [
        { path: "docs/x.md", bytes: new TextEncoder().encode("first") },
        { path: "docs//x.md", bytes: new TextEncoder().encode("second") },
      ],
      "paperclip-demo",
    );
    await expect(readZipArchive(archive)).rejects.toThrow(/duplicate entry path "docs\/x\.md"/i);
  });

  it("bounds a highly compressible DEFLATE entry at the per-entry decompressed limit", async () => {
    // Compresses tiny but expands to 8 KiB; a 1 KiB cap must reject it before it
    // materializes. Real packages sit far under the 256 MB production default.
    const bomb = new TextEncoder().encode("a".repeat(8 * 1024));
    const archive = buildZip([{ path: "bomb.txt", bytes: bomb, method: 8 }], "paperclip-demo");
    await expect(
      readZipArchive(archive, { maxEntryDecompressedBytes: 1024, maxTotalDecompressedBytes: 1 << 30 }),
    ).rejects.toThrow(/per-entry limit/i);
  });

  it("bounds a stored entry at the per-entry decompressed limit", async () => {
    const stored = new TextEncoder().encode("b".repeat(4 * 1024));
    const archive = buildZip([{ path: "big.bin", bytes: stored, method: 0 }], "paperclip-demo");
    await expect(
      readZipArchive(archive, { maxEntryDecompressedBytes: 1024, maxTotalDecompressedBytes: 1 << 30 }),
    ).rejects.toThrow(/per-entry limit/i);
  });

  it("bounds the aggregate decompressed size across many entries", async () => {
    const chunk = new TextEncoder().encode("c".repeat(600));
    const archive = buildZip(
      [
        { path: "a.txt", bytes: chunk, method: 0 },
        { path: "b.txt", bytes: chunk, method: 0 },
      ],
      "paperclip-demo",
    );
    // Each entry is under the per-entry cap, but together they cross the total.
    await expect(
      readZipArchive(archive, { maxEntryDecompressedBytes: 4096, maxTotalDecompressedBytes: 1000 }),
    ).rejects.toThrow(/exceed the 1000-byte limit/i);
  });
});
