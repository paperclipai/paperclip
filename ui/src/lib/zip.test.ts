// @vitest-environment node

import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZipArchive, readZipArchive } from "./zip";

function readUint16(bytes: Uint8Array, offset: number) {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readString(bytes: Uint8Array, offset: number, length: number) {
  return new TextDecoder().decode(bytes.slice(offset, offset + length));
}

function writeUint16(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createDeflatedZipArchive(files: Record<string, string>, rootPath: string) {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;
  let entryCount = 0;

  for (const [relativePath, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const fileName = encoder.encode(`${rootPath}/${relativePath}`);
    const rawBody = encoder.encode(content);
    const deflatedBody = new Uint8Array(deflateRawSync(rawBody));
    const checksum = crc32(rawBody);

    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 8);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, deflatedBody.length);
    writeUint32(localHeader, 22, rawBody.length);
    writeUint16(localHeader, 26, fileName.length);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 8);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, deflatedBody.length);
    writeUint32(centralHeader, 24, rawBody.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, deflatedBody);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + deflatedBody.length;
    entryCount += 1;
  }

  const centralDirectoryLength = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(
    localChunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralDirectoryLength + 22,
  );
  let offset = 0;
  for (const chunk of localChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  const centralDirectoryOffset = offset;
  for (const chunk of centralChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  writeUint32(archive, offset, 0x06054b50);
  writeUint16(archive, offset + 8, entryCount);
  writeUint16(archive, offset + 10, entryCount);
  writeUint32(archive, offset + 12, centralDirectoryLength);
  writeUint32(archive, offset + 16, centralDirectoryOffset);

  return archive;
}

function createZipArchiveWithDirectoryEntries(rootPath: string) {
  const encoder = new TextEncoder();
  const entries = [
    { path: `${rootPath}/`, body: new Uint8Array(0), compressionMethod: 0 },
    { path: `${rootPath}/agents/`, body: new Uint8Array(0), compressionMethod: 0 },
    { path: `${rootPath}/agents/ceo/`, body: new Uint8Array(0), compressionMethod: 0 },
    { path: `${rootPath}/COMPANY.md`, body: encoder.encode("# Company\n"), compressionMethod: 8 },
    { path: `${rootPath}/agents/ceo/AGENTS.md`, body: encoder.encode("# CEO\n"), compressionMethod: 8 },
  ].map((entry) => ({
    ...entry,
    data: entry.compressionMethod === 8 ? new Uint8Array(deflateRawSync(entry.body)) : entry.body,
    checksum: crc32(entry.body),
  }));

  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileName = encoder.encode(entry.path);
    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, entry.compressionMethod);
    writeUint32(localHeader, 14, entry.checksum);
    writeUint32(localHeader, 18, entry.data.length);
    writeUint32(localHeader, 22, entry.body.length);
    writeUint16(localHeader, 26, fileName.length);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, entry.compressionMethod);
    writeUint32(centralHeader, 16, entry.checksum);
    writeUint32(centralHeader, 20, entry.data.length);
    writeUint32(centralHeader, 24, entry.body.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, entry.data);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + entry.data.length;
  }

  const centralDirectoryLength = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(
    localChunks.reduce((sum, chunk) => sum + chunk.length, 0) + centralDirectoryLength + 22,
  );
  let offset = 0;
  for (const chunk of localChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  const centralDirectoryOffset = offset;
  for (const chunk of centralChunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  writeUint32(archive, offset, 0x06054b50);
  writeUint16(archive, offset + 8, entries.length);
  writeUint16(archive, offset + 10, entries.length);
  writeUint32(archive, offset + 12, centralDirectoryLength);
  writeUint32(archive, offset + 16, centralDirectoryOffset);

  return archive;
}

describe("createZipArchive", () => {
  it("writes a zip archive with the export root path prefixed into each entry", () => {
    const archive = createZipArchive(
      {
        "COMPANY.md": "# Company\n",
        "agents/ceo/AGENTS.md": "# CEO\n",
      },
      "paperclip-demo",
    );

    expect(readUint32(archive, 0)).toBe(0x04034b50);

    const firstNameLength = readUint16(archive, 26);
    const firstBodyLength = readUint32(archive, 18);
    expect(readString(archive, 30, firstNameLength)).toBe("paperclip-demo/agents/ceo/AGENTS.md");
    expect(readString(archive, 30 + firstNameLength, firstBodyLength)).toBe("# CEO\n");

    const secondOffset = 30 + firstNameLength + firstBodyLength;
    expect(readUint32(archive, secondOffset)).toBe(0x04034b50);

    const secondNameLength = readUint16(archive, secondOffset + 26);
    const secondBodyLength = readUint32(archive, secondOffset + 18);
    expect(readString(archive, secondOffset + 30, secondNameLength)).toBe("paperclip-demo/COMPANY.md");
    expect(readString(archive, secondOffset + 30 + secondNameLength, secondBodyLength)).toBe("# Company\n");

    const endOffset = archive.length - 22;
    expect(readUint32(archive, endOffset)).toBe(0x06054b50);
    expect(readUint16(archive, endOffset + 8)).toBe(2);
    expect(readUint16(archive, endOffset + 10)).toBe(2);
  });

  it("reads a Paperclip zip archive back into rootPath and file contents", async () => {
    const archive = createZipArchive(
      {
        "COMPANY.md": "# Company\n",
        "agents/ceo/AGENTS.md": "# CEO\n",
        ".paperclip.yaml": "schema: paperclip/v1\n",
      },
      "paperclip-demo",
    );

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "# Company\n",
        "agents/ceo/AGENTS.md": "# CEO\n",
        ".paperclip.yaml": "schema: paperclip/v1\n",
      },
    });
  });

  it("round-trips binary image files without coercing them to text", async () => {
    const archive = createZipArchive(
      {
        "images/company-logo.png": {
          encoding: "base64",
          data: Buffer.from("png-bytes").toString("base64"),
          contentType: "image/png",
        },
      },
      "paperclip-demo",
    );

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "images/company-logo.png": {
          encoding: "base64",
          data: Buffer.from("png-bytes").toString("base64"),
          contentType: "image/png",
        },
      },
    });
  });

  it("reads standard DEFLATE zip archives created outside Paperclip", async () => {
    const archive = createDeflatedZipArchive(
      {
        "COMPANY.md": "# Company\n",
        "agents/ceo/AGENTS.md": "# CEO\n",
      },
      "paperclip-demo",
    );

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "# Company\n",
        "agents/ceo/AGENTS.md": "# CEO\n",
      },
    });
  });

  it("ignores directory entries from standard zip archives", async () => {
    const archive = createZipArchiveWithDirectoryEntries("paperclip-demo");

    await expect(readZipArchive(archive)).resolves.toEqual({
      rootPath: "paperclip-demo",
      files: {
        "COMPANY.md": "# Company\n",
        "agents/ceo/AGENTS.md": "# CEO\n",
      },
    });
  });
});
