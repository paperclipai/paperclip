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

export function createStoredZipArchive(files: Record<string, string>, rootPath: string) {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let localOffset = 0;
  let entryCount = 0;

  for (const [relativePath, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const fileName = encoder.encode(`${rootPath}/${relativePath}`);
    const body = encoder.encode(content);
    const checksum = crc32(body);

    const localHeader = new Uint8Array(30 + fileName.length);
    writeUint32(localHeader, 0, 0x04034b50);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0x0800);
    writeUint16(localHeader, 8, 0);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, body.length);
    writeUint32(localHeader, 22, body.length);
    writeUint16(localHeader, 26, fileName.length);
    localHeader.set(fileName, 30);

    const centralHeader = new Uint8Array(46 + fileName.length);
    writeUint32(centralHeader, 0, 0x02014b50);
    writeUint16(centralHeader, 4, 20);
    writeUint16(centralHeader, 6, 20);
    writeUint16(centralHeader, 8, 0x0800);
    writeUint16(centralHeader, 10, 0);
    writeUint32(centralHeader, 16, checksum);
    writeUint32(centralHeader, 20, body.length);
    writeUint32(centralHeader, 24, body.length);
    writeUint16(centralHeader, 28, fileName.length);
    writeUint32(centralHeader, 42, localOffset);
    centralHeader.set(fileName, 46);

    localChunks.push(localHeader, body);
    centralChunks.push(centralHeader);
    localOffset += localHeader.length + body.length;
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
