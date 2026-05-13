import { createHash } from "node:crypto";

const DNS_1123_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_LABEL = 63;
const HASH_LENGTH = 8;

export function isValidDns1123Label(s: string): boolean {
  return s.length > 0 && s.length <= MAX_LABEL && DNS_1123_LABEL.test(s);
}

function shortHash(input: string): string {
  // base36 of first 5 bytes of sha256 → ≤8 chars, lowercase alphanumeric only.
  const hash = createHash("sha256").update(input).digest();
  let n = 0n;
  for (let i = 0; i < 5; i++) n = (n << 8n) + BigInt(hash[i]);
  return n.toString(36).slice(0, HASH_LENGTH).padStart(HASH_LENGTH, "0");
}

function sanitizeSlug(slug: string): string {
  // Lowercase, replace runs of invalid chars with single hyphen, trim leading/trailing hyphens.
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length === 0 ? "x" : cleaned;
}

export interface DeriveNamespaceNameInput {
  companySlug: string;
  companyId: string;
  prefix: string;
  collisionFallback?: boolean;
}

export function deriveNamespaceName(input: DeriveNamespaceNameInput): string {
  const { companySlug, companyId, prefix, collisionFallback } = input;
  const slug = sanitizeSlug(companySlug);
  const naive = `${prefix}${slug}`;

  // The hash suffix is appended when ANY of:
  //   - explicit collision fallback requested
  //   - naive name overflows 63 chars
  //   - sanitization mangled the slug (e.g. "Acme Corp.!" → "acme-corp")
  const sanitizedDiffers = slug !== companySlug.toLowerCase();
  const overflow = naive.length > MAX_LABEL;
  if (!collisionFallback && !overflow && !sanitizedDiffers) return naive;

  const suffix = `-${shortHash(companyId)}`;
  const room = MAX_LABEL - prefix.length - suffix.length;
  const truncatedSlug = slug.slice(0, Math.max(1, room)).replace(/-+$/g, "");
  return `${prefix}${truncatedSlug}${suffix}`;
}
