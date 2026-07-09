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
