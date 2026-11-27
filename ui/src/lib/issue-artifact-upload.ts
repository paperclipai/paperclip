import { isArtifactReviewDocumentKey, isSystemIssueDocumentKey } from "@paperclipai/shared";

/** Uploaded filenames must never select a hidden or internal document key. */
export function uploadedDocumentKey(filename: string, existingKeys: Iterable<string>): string {
  const slug = filename.replace(/\.[^.]+$/, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "document";
  const visibleSlug = isSystemIssueDocumentKey(slug) || isArtifactReviewDocumentKey(slug)
    ? `upload-${slug}` : slug;
  const base = visibleSlug.slice(0, 54);
  const keys = new Set(existingKeys);
  let key = base;
  let suffix = 2;
  while (keys.has(key)) key = `${base}-${suffix++}`;
  return key;
}
