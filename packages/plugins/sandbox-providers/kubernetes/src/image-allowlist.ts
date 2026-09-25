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

export interface ResolveImageInput {
  imageOverride?: string | null;
}

export interface ResolveImageDefaults {
  runtimeImage: string;
}

export interface ResolveImageConfig {
  imageAllowList: string[];
  imageRegistry?: string;
}

export function resolveImage(
  target: ResolveImageInput,
  defaults: ResolveImageDefaults,
  config: ResolveImageConfig,
): string {
  if (target.imageOverride) {
    if (!config.imageAllowList.some((p) => globMatch(p, target.imageOverride!))) {
      throw new Error(`Image override "${target.imageOverride}" is not in allowlist`);
    }
    return target.imageOverride;
  }
  if (config.imageRegistry) {
    return rewriteRegistry(defaults.runtimeImage, config.imageRegistry);
  }
  return defaults.runtimeImage;
}

function rewriteRegistry(image: string, registry: string): string {
  // image is like "ghcr.io/paperclipai/agent-runtime-claude:v1"
  // we want to replace the first two path segments (host + org) with `registry`
  const cleanRegistry = registry.replace(/\/+$/, "");
  const colonIdx = image.lastIndexOf(":");
  const tag = colonIdx >= 0 ? image.slice(colonIdx) : "";
  const path = colonIdx >= 0 ? image.slice(0, colonIdx) : image;
  const segments = path.split("/");
  // Strip the host+org (first two segments), keep the image name
  const imageName = segments.slice(2).join("/") || segments[segments.length - 1];
  return `${cleanRegistry}/${imageName}${tag}`;
}

/**
 * Picks the Kubernetes `imagePullPolicy` for a resolved image reference.
 *
 * Digest-pinned references (`...@sha256:...`) and explicit immutable-looking
 * version tags (anything other than a floating alias) are safe to cache
 * across pods with `IfNotPresent` — the reference can only ever resolve to
 * one set of bytes.
 *
 * Floating tags (`:latest`, `:dev`, `:main`, `:stable`, or no tag at all,
 * which Docker treats as `:latest`) can be re-pointed at a new digest by a
 * later publish without the reference itself changing. With
 * `IfNotPresent`, a node that already cached an old `:latest` pull keeps
 * serving stale bytes to every pod scheduled there until something evicts
 * the cached layer, so different nodes can silently run different
 * versions of "the same" image. Force `Always` for those so every pod
 * start re-checks the registry for the current digest.
 */
const FLOATING_TAGS = new Set(["latest", "dev", "main", "stable"]);

export function imagePullPolicyFor(image: string): "Always" | "IfNotPresent" {
  if (image.includes("@sha256:")) {
    return "IfNotPresent";
  }
  const lastSegment = image.split("/").pop() ?? image;
  const colonIdx = lastSegment.lastIndexOf(":");
  const tag = colonIdx >= 0 ? lastSegment.slice(colonIdx + 1) : "latest";
  return FLOATING_TAGS.has(tag) ? "Always" : "IfNotPresent";
}

/**
 * Same as {@link imagePullPolicyFor}, but lets an operator force
 * `IfNotPresent` for every image regardless of tag shape.
 *
 * An air-gapped/offline cluster may preload runtime images onto its nodes
 * out-of-band (e.g. via `ctr images import` or a node image baked with the
 * image already present) and has no path to the registry at pod-start time.
 * Forcing `Always` for floating tags in that setup turns every pod start
 * into an `ImagePullBackOff`, even though the correct bytes are already
 * sitting on the node. Setting `preloadedImages: true` in the provider
 * config opts back into the old `IfNotPresent`-always behavior for that
 * deployment style.
 */
export function resolveImagePullPolicy(
  image: string,
  preloadedImages: boolean | undefined,
): "Always" | "IfNotPresent" {
  if (preloadedImages) {
    return "IfNotPresent";
  }
  return imagePullPolicyFor(image);
}
