export const DEFAULT_JSON_BODY_LIMIT = "10mb";
export const PORTABLE_JSON_BODY_LIMIT = "64mb";
export const PORTABLE_JSON_BODY_LIMIT_BYTES = 64 * 1024 * 1024;

// A company import can also be uploaded as its raw compressed zip (multipart or
// application/zip) instead of an inflated inline JSON body. The compressed zip
// is roughly a third of the inline size, but the limit is kept generous so a
// large company package uploads in one request rather than truncating in transit.
export const PORTABLE_ZIP_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024;
