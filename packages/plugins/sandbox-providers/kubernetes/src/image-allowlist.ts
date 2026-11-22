/**
 * Glob matching for image references.
 * - `*` matches any sequence of characters EXCEPT `/` (so a wildcard doesn't span path segments)
 * - `?` matches exactly one character (excluding `/`)
 */
export function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]") +
      "$",
  );
  return re.test(value);
}

const SHA256_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DIGEST_IMAGE_RE = /^([^@\s]+)@(sha256:[a-f0-9]{64})$/;

export class ImageDigestRequiredError extends Error {
  readonly code = "IMAGE_DIGEST_REQUIRED";
  constructor(image: string) {
    super(`Image reference "${image}" must pin an immutable @sha256:<64-hex> digest`);
    this.name = "ImageDigestRequiredError";
  }
}

export class InvalidPlatformDigestError extends Error {
  readonly code = "INVALID_PLATFORM_DIGEST";
  constructor(digest: string) {
    super(`Invalid platformDigest "${digest}": expected sha256:<64-lowercase-hex>`);
    this.name = "InvalidPlatformDigestError";
  }
}

export interface ParsedDigestImageRef {
  repository: string;
  tag: string | null;
  digest: string;
}

export function isValidSha256Digest(digest: string): boolean {
  return SHA256_DIGEST_RE.test(digest);
}

/**
 * Parses an OCI image reference pinned with an immutable SHA-256 digest.
 * Correctly handles registries with explicit port numbers (e.g. registry.example:5000/org/img@sha256:...).
 */
export function parseDigestImageRef(image: string): ParsedDigestImageRef | null {
  const trimmed = image.trim();
  const match = DIGEST_IMAGE_RE.exec(trimmed);
  if (!match) return null;
  const [, nameWithOptionalTag, digest] = match;
  const lastSlash = nameWithOptionalTag.lastIndexOf("/");
  const lastColon = nameWithOptionalTag.lastIndexOf(":");
  if (lastColon > lastSlash) {
    const repository = nameWithOptionalTag.slice(0, lastColon);
    const tag = nameWithOptionalTag.slice(lastColon + 1);
    if (!repository || !tag) return null;
    return { repository, tag, digest };
  }
  return { repository: nameWithOptionalTag, tag: null, digest };
}

export interface ResolveImageInput {
  imageOverride?: string | null;
  platformDigest?: string | null;
}

export interface ResolveImageDefaults {
  runtimeImage: string;
}

export interface ResolveImageConfig {
  imageAllowList: string[];
  imageRegistry?: string;
  requireDigest?: boolean;
}

export interface ResolvedImageRef {
  image: string;
  digest: string | null;
  expectedPlatformDigest: string | null;
  source: "override" | "default";
}

/**
 * Rewrites the registry/org prefix of an image reference while preserving both
 * optional `:tag` and immutable `@sha256:...` digests, and without misparsing
 * host:port prefixes or duplicating an already-matching registry prefix.
 */
export function rewriteRegistry(image: string, registry?: string): string {
  if (!registry) return image;
  const cleanRegistry = registry.replace(/\/+$/, "");
  if (!cleanRegistry) return image;

  const atIdx = image.indexOf("@");
  const digestSuffix = atIdx >= 0 ? image.slice(atIdx) : "";
  const withoutDigest = atIdx >= 0 ? image.slice(0, atIdx) : image;

  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const tagSuffix = hasTag ? withoutDigest.slice(lastColon) : "";
  const repoPath = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;

  if (repoPath === cleanRegistry || repoPath.startsWith(`${cleanRegistry}/`)) {
    return `${repoPath}${tagSuffix}${digestSuffix}`;
  }

  const segments = repoPath.split("/");
  // Strip host+org (first two segments) when present; keep remaining image path.
  const imageName = segments.length > 2 ? segments.slice(2).join("/") : segments[segments.length - 1];
  return `${cleanRegistry}/${imageName}${tagSuffix}${digestSuffix}`;
}

export function resolveImageDetailed(
  target: ResolveImageInput,
  defaults: ResolveImageDefaults,
  config: ResolveImageConfig,
): ResolvedImageRef {
  const expectedPlatformDigest = target.platformDigest?.trim() || null;
  if (expectedPlatformDigest && !isValidSha256Digest(expectedPlatformDigest)) {
    throw new InvalidPlatformDigestError(expectedPlatformDigest);
  }

  const override = target.imageOverride?.trim() || null;
  if (override) {
    const rewritten = config.imageRegistry ? rewriteRegistry(override, config.imageRegistry) : override;
    const allowed = config.imageAllowList.some(
      (p) => globMatch(p, override) || globMatch(p, rewritten),
    );
    if (!allowed) {
      throw new Error(`Image override "${override}" is not in allowlist`);
    }
    const parsed = parseDigestImageRef(rewritten);
    if (config.requireDigest && !parsed) {
      throw new ImageDigestRequiredError(rewritten);
    }
    return {
      image: rewritten,
      digest: parsed?.digest ?? null,
      expectedPlatformDigest,
      source: "override",
    };
  }

  const resolvedDefault = config.imageRegistry
    ? rewriteRegistry(defaults.runtimeImage, config.imageRegistry)
    : defaults.runtimeImage;
  const parsed = parseDigestImageRef(resolvedDefault);
  if (config.requireDigest && !parsed) {
    throw new ImageDigestRequiredError(resolvedDefault);
  }
  return {
    image: resolvedDefault,
    digest: parsed?.digest ?? null,
    expectedPlatformDigest,
    source: "default",
  };
}

export function resolveImage(
  target: ResolveImageInput,
  defaults: ResolveImageDefaults,
  config: ResolveImageConfig,
): string {
  return resolveImageDetailed(target, defaults, config).image;
}
