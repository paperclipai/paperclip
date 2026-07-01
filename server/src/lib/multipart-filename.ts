/**
 * multer (via busboy) decodes the multipart `Content-Disposition` `filename`
 * parameter as latin1. Filenames that contain non-ASCII UTF-8 bytes (for example
 * Korean, Japanese, or accented characters) therefore arrive mojibaked in
 * `file.originalname` and get persisted that way.
 *
 * This reverses that specific mis-decode when — and only when — the stored value
 * round-trips cleanly as latin1-encoded UTF-8. Names that are already correct
 * (ASCII, valid UTF-8, etc.) are returned unchanged, so the function is safe to
 * apply unconditionally and is idempotent.
 */
export function decodeMultipartFilename<T extends string | null | undefined>(name: T): T {
  if (name == null || name === "") return name;
  try {
    const decoded = Buffer.from(name, "latin1").toString("utf8");
    if (
      decoded !== name &&
      !decoded.includes("�") &&
      Buffer.from(decoded, "utf8").toString("latin1") === name
    ) {
      return decoded as T;
    }
  } catch {
    // Fall through and return the original name unchanged.
  }
  return name;
}
