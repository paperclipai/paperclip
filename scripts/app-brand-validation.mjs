export const assetPathPattern = /^\/brands\/apps\/[a-z0-9-]+\.(svg|png)$/;
export const normalizeBrandKey = (value) => value.trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Conservative structural rejection, not a general-purpose SVG sanitizer.
// Original accepted artwork is copied byte-for-byte, never rewritten here.
export function validateArtwork(bytes, filename) {
  if (filename.endsWith(".png")) {
    if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || bytes.toString("ascii", 12, 16) !== "IHDR" || bytes.readUInt32BE(16) === 0 || bytes.readUInt32BE(20) === 0
      || bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND") {
      throw new Error(`${filename}: invalid PNG signature`);
    }
    return;
  }
  const svg = bytes.toString("utf8");
  if (!filename.endsWith(".svg") || (!/<svg\b[^>]*\bviewBox\s*=\s*["'][^"']+["']/i.test(svg) && !(/<svg\b[^>]*\bwidth\s*=\s*["'][0-9.]+(?:px)?["']/i.test(svg) && /<svg\b[^>]*\bheight\s*=\s*["'][0-9.]+(?:px)?["']/i.test(svg)))) {
    throw new Error(`${filename}: SVG requires a viewBox or intrinsic width and height`);
  }
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|&#|<\s*(?:[\w-]+:)?(?:script|foreignObject|image|feImage|iframe|object|embed|animate\w*|set|a)\b|\bon[\w-]+\s*=/i.test(svg)
    || /\b(?:[\w-]+:)?href\s*=\s*["'](?!#)/i.test(svg)
    || /@import|@media|url\(\s*["']?(?!#)[^)]*\)|(?:javascript|data|https?):|\\/i.test(svg.replace(/xmlns(?::[\w-]+)?\s*=\s*["'][^"']*["']/gi, ""))) {
    throw new Error(`${filename}: unsafe SVG feature, external resource, theme media query, or embedded raster wrapper`);
  }
}

export function validateManifest(manifest, readAsset) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.providers)) throw new Error("Invalid brand manifest");
  const keys = new Map();
  const slugs = new Set();
  for (const row of manifest.providers) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.slug) || slugs.has(row.slug)) throw new Error(`Duplicate or invalid slug: ${row.slug}`);
    slugs.add(row.slug);
    if (typeof row.provider !== "string" || !row.provider.trim()) throw new Error(`${row.slug}: missing provider name`);
    const aliases = row.aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some((alias) => typeof alias !== "string" || !alias.trim())) throw new Error(`${row.slug}: invalid aliases`);
    for (const name of [row.slug, row.provider, ...aliases]) {
      const key = normalizeBrandKey(name);
      if (keys.has(key) && keys.get(key) !== row.slug) throw new Error(`${row.slug}: ambiguous brand alias ${name}`);
      keys.set(key, row.slug);
    }
    for (const asset of new Set([row.localAsset, ...(row.darkAsset === undefined ? [] : [row.darkAsset])])) {
      if (typeof asset !== "string" || !assetPathPattern.test(asset)) throw new Error(`${row.slug}: invalid asset path`);
      validateArtwork(readAsset(asset), asset);
    }
  }
  return manifest.providers.length;
}
