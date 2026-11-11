import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export function removeControllerArtifactsFromProviderPack(packRoot) {
  for (const directory of ["bin", "remote-provider-packs"]) {
    rmSync(join(packRoot, "dist", directory), { recursive: true, force: true });
  }
}

/** libc family of the Node copied into the pack; undefined where npm has no libc field. */
export function providerPackLibc(platform = process.platform, report = () => process.report.getReport()) {
  if (platform !== "linux") return undefined;
  return report().header.glibcVersionRuntime ? "glibc" : "musl";
}

function ownPackageManifests(entryRoot) {
  // In pnpm's virtual store an entry's own package is the only real directory
  // under its node_modules; every dependency beside it is a symlink.
  const modules = join(entryRoot, "node_modules");
  if (!existsSync(modules)) return [];
  const manifests = [];
  for (const child of readdirSync(modules, { withFileTypes: true })) {
    const children = child.isDirectory() && child.name.startsWith("@")
      ? readdirSync(join(modules, child.name), { withFileTypes: true }).map(scoped => ({ entry: scoped, path: join(modules, child.name, scoped.name) }))
      : [{ entry: child, path: join(modules, child.name) }];
    for (const { entry, path } of children) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && existsSync(join(path, "package.json"))) {
        manifests.push(JSON.parse(readFileSync(join(path, "package.json"), "utf8")));
      }
    }
  }
  return manifests;
}

/**
 * Remove whole pnpm virtual-store entries and every link that resolves into
 * them, so no dangling dependency slot survives into the immutable pack.
 */
export function removePnpmStoreEntries(packRoot, entryNames) {
  const store = join(packRoot, "node_modules", ".pnpm");
  const removed = entryNames.map(name => {
    const path = resolve(store, name);
    if (dirname(path) !== store || name === "node_modules") throw new Error(`Refusing to remove pnpm store path ${name}`);
    return path;
  });
  if (!removed.length) return;
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  const inside = target => removed.some(path => target === path || target.startsWith(`${path}${sep}`));
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (inside(resolve(directory, readlinkSync(path)))) unlinkSync(path);
      } else if (entry.isDirectory()) {
        visit(path);
        if (entry.name.startsWith("@") && readdirSync(path).length === 0) rmdirSync(path);
      }
    }
  };
  visit(join(packRoot, "node_modules"));
}

/**
 * pnpm keeps optional platform packages for every libc on the target OS/CPU.
 * The pack only runs its own copied Node, so packages built for the other libc
 * can never load; the Claude and OpenCode musl builds add 400-600 MB per pack.
 */
export function removeForeignLibcPackagesFromProviderPack(packRoot, libc) {
  if (!libc) return [];
  const store = join(packRoot, "node_modules", ".pnpm");
  const foreign = readdirSync(store, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== "node_modules")
    .map(entry => entry.name)
    .filter(name => {
      const manifests = ownPackageManifests(join(store, name));
      return manifests.length > 0 && manifests.every(manifest => Array.isArray(manifest.libc) && !manifest.libc.includes(libc));
    })
    .sort();
  removePnpmStoreEntries(packRoot, foreign);
  return foreign;
}

/** The pnpm virtual-store entry that owns a resolved package path inside the pack. */
export function pnpmStoreEntryOf(packRoot, path) {
  const parts = relative(realpathSync(join(packRoot, "node_modules", ".pnpm")), realpathSync(path)).split(sep);
  if (parts.length < 2 || parts[0] === ".." || parts[0] === "node_modules" || basename(parts[0]) !== parts[0]) {
    throw new Error(`${path} is not inside the provider pack's pnpm store`);
  }
  return parts[0];
}
