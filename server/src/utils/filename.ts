/**
 * Multer decodes the filename from the Content-Disposition header using
 * Latin-1 (per RFC 7578 §4.2). When the browser sends a UTF-8 filename,
 * each UTF-8 byte is misinterpreted as a Latin-1 code point, producing a
 * double-encoded string. This helper re-encodes the Latin-1 string back
 * to bytes and decodes them as UTF-8 to recover the original filename.
 *
 * Falls back to the original string if the bytes are not valid UTF-8
 * (i.e. the filename was genuinely Latin-1).
 */
export function fixMulterFilename(name: string): string {
  try {
    const bytes = Buffer.from(name, "latin1");
    const decoded = bytes.toString("utf8");
    return decoded.includes("\uFFFD") ? name : decoded;
  } catch {
    return name;
  }
}
