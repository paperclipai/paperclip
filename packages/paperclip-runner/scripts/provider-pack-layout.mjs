import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** runnerd is shipped and verified separately from the JavaScript provider pack. */
export function normalizeProviderPackLayout(packRoot) {
  const dist = join(packRoot, "dist");
  if (!existsSync(dist)) return;
  if (!lstatSync(dist).isDirectory()) {
    throw new Error("Provider pack dist must be a directory");
  }
  const bin = join(dist, "bin");
  if (!existsSync(bin)) return;
  if (!lstatSync(bin).isDirectory()) {
    throw new Error("Provider pack dist/bin must be a directory");
  }
  rmSync(join(bin, "paperclip-runnerd"), { force: true });
  // Keep every other entry, including future provider executables.
  if (readdirSync(bin).length === 0) rmdirSync(bin);
}

/** Remove build-specific bytes before binding the complete immutable pack tree. */
export function normalizeProviderPackMetadata(packRoot) {
  const root = realpathSync(packRoot);
  const buildRoots = [...new Set([root, resolve(packRoot)])].sort((a, b) => b.length - a.length);
  const containsBuildRoot = (text) => buildRoots.some((path) => text.includes(path));
  let normalizedShims = 0;
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      // Walk physical directories only; the integrity verifier checks link confinement.
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.isFile() || basename(directory) !== ".bin") continue;
      if (lstatSync(file).size > 64 * 1024) continue; // Preserve non-shim executables.
      const body = readFileSync(file, "utf8");
      if (!containsBuildRoot(body)) continue;
      const lines = body.split("\n"), base = lines.flatMap((line, index) => line.startsWith("basedir=") ? [index] : []);
      if (!body.startsWith("#!/bin/sh\n") || base.length !== 1
        || lines.some((line) => containsBuildRoot(line) && !line.startsWith('  export NODE_PATH="'))) {
        throw new Error("Unrecognized build-dependent provider shim");
      }
      // Resolve the physical launcher directory before ascending to the pack.
      // Callers can invoke it through pnpm package links or task-local symlinks.
      const ascent = relative(dirname(file), root).split(sep).join("/");
      const preamble = [
        'paperclip_self=$0; paperclip_links=0',
        'while [ -L "$paperclip_self" ]; do',
        '  paperclip_links=$((paperclip_links + 1)); [ "$paperclip_links" -le 40 ] || exit 1',
        '  paperclip_parent=$(CDPATH= cd -P -- "$(dirname -- "$paperclip_self")" && pwd -P) || exit 1',
        '  paperclip_self=$(readlink -- "$paperclip_self") || exit 1',
        '  case "$paperclip_self" in /*) ;; *) paperclip_self=$paperclip_parent/$paperclip_self ;; esac',
        'done',
        'basedir=$(CDPATH= cd -P -- "$(dirname -- "$paperclip_self")" && pwd -P) || exit 1',
        `paperclip_pack_root=$(CDPATH= cd -P -- "$basedir/${ascent}" && pwd -P) || exit 1`,
      ].join("\n");
      lines[base[0]] = preamble;
      let normalized = lines.join("\n");
      for (const buildRoot of buildRoots) normalized = normalized.split(buildRoot).join("${paperclip_pack_root}");
      writeFileSync(file, normalized);
      normalizedShims++;
    }
  }
  const modules = join(root, "node_modules");
  if (!lstatSync(modules).isDirectory()) throw new Error("Provider node_modules must be a physical directory");
  visit(modules);
  const metadata = join(modules, ".modules.yaml");
  if (existsSync(metadata)) {
    const stat = lstatSync(metadata);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Provider package-manager metadata must be a bounded regular file");
    const body = readFileSync(metadata, "utf8");
    if ([...body.matchAll(/^prunedAt: .*$/gm)].length !== 1) throw new Error("Unexpected provider package-manager timestamp metadata");
    // pnpm's pruning time is bookkeeping, not runtime content. Keep its format
    // and all other metadata, with the same value in every isolated build.
    writeFileSync(metadata, body.replace(/^prunedAt: .*$/m, "prunedAt: Thu, 01 Jan 1970 00:00:00 GMT"));
  }
  return { normalizedShims };
}
