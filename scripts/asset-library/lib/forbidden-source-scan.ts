// Forbidden-source detector for upload-time scan.
// extend list here — see GLA-927 (https://github.com/jqueguiner/openrunner) tracker
// for the policy. Add new patterns to FORBIDDEN_FILENAME_PATTERNS or
// FORBIDDEN_URL_PATTERNS below and update the unit tests.

import exifr from "exifr";

export type ScanVerdict =
  | { kind: "pass" }
  | {
      kind: "block";
      source: string;
      reason: string;
      pattern: string;
      detector: "filename" | "exif";
    };

type FilenameRule = { source: string; pattern: RegExp; reason: string; label: string };
type UrlRule = { source: string; pattern: RegExp; reason: string; label: string };

const FORBIDDEN_FILENAME_PATTERNS: FilenameRule[] = [
  {
    source: "shutterstock",
    pattern: /shutterstock_\d+\.(jpe?g|png|mp4|mov|webp)$/i,
    reason: "Shutterstock filename detected",
    label: "shutterstock_<digits>",
  },
  {
    source: "getty",
    pattern: /GettyImages-\d+/i,
    reason: "Getty / iStock filename detected",
    label: "GettyImages-<digits>",
  },
  {
    source: "adobe-stock",
    pattern: /AdobeStock_\d+/i,
    reason: "Adobe Stock filename detected",
    label: "AdobeStock_<digits>",
  },
];

const FORBIDDEN_URL_PATTERNS: UrlRule[] = [
  {
    source: "unsplash",
    pattern: /unsplash\.com\/photos\//i,
    reason: "Unsplash source URL detected in EXIF metadata",
    label: "unsplash.com/photos/",
  },
  {
    source: "shutterstock",
    pattern: /shutterstock\.com\//i,
    reason: "Shutterstock URL detected in EXIF metadata",
    label: "shutterstock.com/",
  },
  {
    source: "getty",
    pattern: /gettyimages\.com\//i,
    reason: "Getty URL detected in EXIF metadata",
    label: "gettyimages.com/",
  },
  {
    source: "adobe-stock",
    pattern: /stock\.adobe\.com\//i,
    reason: "Adobe Stock URL detected in EXIF metadata",
    label: "stock.adobe.com/",
  },
];

const IMAGE_EXIF_EXTS = new Set(["jpg", "jpeg", "tif", "tiff", "heic", "heif", "png", "webp"]);

export function scanFilename(filename: string): ScanVerdict {
  const base = filename.split("/").pop() ?? filename;
  for (const rule of FORBIDDEN_FILENAME_PATTERNS) {
    if (rule.pattern.test(base)) {
      return {
        kind: "block",
        source: rule.source,
        reason: rule.reason,
        pattern: rule.label,
        detector: "filename",
      };
    }
  }
  return { kind: "pass" };
}

export async function scanExifMetadata(buffer: Buffer, filename: string): Promise<ScanVerdict> {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  if (!IMAGE_EXIF_EXTS.has(ext)) return { kind: "pass" };

  let metadata: Record<string, unknown> | undefined;
  try {
    metadata = (await exifr.parse(buffer, ["XPComment", "XPSubject", "XPKeywords", "ImageDescription", "Source", "Copyright", "Artist", "Software", "DocumentName", "PageName", "Description", "Title", "Subject", "Keywords"])) as
      | Record<string, unknown>
      | undefined;
  } catch {
    return { kind: "pass" };
  }
  if (!metadata) return { kind: "pass" };

  const haystack = JSON.stringify(metadata);
  for (const rule of FORBIDDEN_URL_PATTERNS) {
    if (rule.pattern.test(haystack)) {
      return {
        kind: "block",
        source: rule.source,
        reason: rule.reason,
        pattern: rule.label,
        detector: "exif",
      };
    }
  }
  return { kind: "pass" };
}

export async function scanUpload(filename: string, buffer: Buffer): Promise<ScanVerdict> {
  const filenameVerdict = scanFilename(filename);
  if (filenameVerdict.kind === "block") return filenameVerdict;
  return scanExifMetadata(buffer, filename);
}
