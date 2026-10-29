import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Keep npm's installed-tree traversal out of non-bundled package packing.
 * Copy manifests and pack rules unchanged; npm still selects the tarball files.
 * Bundled packages need their dependency tree, so keep their existing pack path.
 */
export async function withInstalledPackagePackInput(packageRoot, scratchRoot, pack) {
  const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const hasBundle = [manifest.bundleDependencies, manifest.bundledDependencies].some(
    value => value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0),
  );
  if (hasBundle) return pack(packageRoot, false);

  const stage = await mkdtemp(join(scratchRoot, "pack-input-"));
  try {
    const input = join(stage, "package");
    // node_modules is excluded by npm for non-bundled packages. Preserve every
    // other entry, including ignore rules and links, without dereferencing it.
    await cp(packageRoot, input, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: source => resolve(source) !== resolve(packageRoot, "node_modules"),
    });
    return await pack(input, true);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
