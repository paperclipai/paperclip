export const DEFAULT_JSON_BODY_LIMIT = "10mb";
export const PORTABLE_JSON_BODY_LIMIT = "64mb";
export const PORTABLE_JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

// A company import can also be uploaded as its raw compressed zip (multipart or
// application/zip) instead of an inflated inline JSON body. The compressed zip
// is roughly a third of the inline size, but the limit is kept generous so a
// large company package uploads in one request rather than truncating in transit.
// The whole upload is buffered in memory and unzipped in one pass, so this cap
// bounds peak per-import memory (roughly the compressed size plus the inflated
// package). Operators who need more (or less) headroom can override it with
// PAPERCLIP_IMPORT_ZIP_MAX_BYTES; the import route scales its decompression-bomb
// guards from whatever value is in effect.
// The override is clamped to [1 byte, 64 GiB]: a fractional value would floor
// to a zero-byte limit that rejects every upload, and an astronomically large
// one would overflow the derived 4x decompression guard. 64 GiB is far beyond
// what the in-memory import pipeline can serve anyway.
const MAX_ZIP_UPLOAD_LIMIT_OVERRIDE_BYTES = 64 * 1024 * 1024 * 1024;
const zipUploadLimitOverride = Math.floor(Number(process.env.PAPERCLIP_IMPORT_ZIP_MAX_BYTES));
export const PORTABLE_ZIP_UPLOAD_LIMIT_BYTES =
  Number.isFinite(zipUploadLimitOverride) && zipUploadLimitOverride >= 1
    ? Math.min(zipUploadLimitOverride, MAX_ZIP_UPLOAD_LIMIT_OVERRIDE_BYTES)
    : 1024 * 1024 * 1024;
