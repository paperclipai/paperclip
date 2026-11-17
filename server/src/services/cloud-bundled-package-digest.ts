import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cloudConfigurationDigest } from "./cloud-configuration-evidence.js";

export function cloudBundledPackageDigest(packageRoot: string, options: { catalogRoot?: string } = {}): string {
  const root = fs.realpathSync(packageRoot);
  const roots = [{ key: "package", directory: root }];
  let imageNodeModules: string | undefined;
  if (options.catalogRoot) {
    const catalogRoot = fs.realpathSync(options.catalogRoot);
    const relative = path.relative(catalogRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Image package is outside the selected catalog root");
    imageNodeModules = path.resolve(catalogRoot, "../../node_modules");
    roots.push(
      { key: "plugin-sdk", directory: path.join(catalogRoot, "sdk") },
      { key: "shared", directory: path.resolve(catalogRoot, "../shared") },
      { key: "image-node-modules", directory: imageNodeModules },
    );
  }
  roots.sort((left, right) => right.directory.length - left.directory.length);
  const inventory = new Map<string, [string, string, string, number]>();
  const directories = new Set<string>();
  const files = new Set<string>();
  const buffer = Buffer.alloc(65_536);
  let bytes = 0;
  let entries = 0;

  function logical(file: string): string {
    for (const candidate of roots) {
      const relative = path.relative(candidate.directory, file);
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        if (relative.split(path.sep).length > 32) throw new Error("Image package exceeds the directory depth limit");
        return `${candidate.key}/${relative.split(path.sep).join("/")}`;
      }
    }
    throw new Error(options.catalogRoot ? "Image dependency escapes its authorized image roots" : "Image package symlink escapes its package");
  }

  function follow(target: string) {
    logical(target);
    if (imageNodeModules) {
      const relative = path.relative(imageNodeModules, target).split(path.sep);
      if ((relative.length === 1 && relative[0] === "")
        || (relative[0] === ".pnpm" && (relative.length === 1 || (relative.length === 2 && relative[1] === "node_modules")))) {
        throw new Error("Image dependency must select an individual package");
      }
      if (relative[0] === ".pnpm" && relative.length > 2 && relative[1] && relative[1] !== "node_modules") {
        walk(path.join(imageNodeModules, ".pnpm", relative[1]));
        return;
      }
    }
    walk(target);
  }

  function walk(file: string) {
    const name = logical(file);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(file);
      inventory.set(name, [name, "link", logical(target), stat.mode & 0o777]);
      follow(target);
    } else if (stat.isDirectory()) {
      const real = fs.realpathSync(file);
      logical(real);
      if (directories.has(real)) return;
      directories.add(real);
      for (const child of fs.readdirSync(real).sort()) {
        if (++entries > 50_000) throw new Error("Image package exceeds the entry limit");
        walk(path.join(real, child));
      }
    } else if (stat.isFile()) {
      const real = fs.realpathSync(file);
      if (files.has(real)) return;
      files.add(real);
      if (path.basename(file) === "package.json" && stat.size > 128 * 1024) throw new Error("Image package metadata exceeds the byte limit");
      if (bytes + stat.size > 256 * 1024 * 1024) throw new Error("Image package exceeds the byte limit");
      const handle = fs.openSync(file, "r");
      const hash = createHash("sha256");
      try {
        while (true) {
          const count = fs.readSync(handle, buffer);
          if (!count) break;
          bytes += count;
          if (bytes > 256 * 1024 * 1024) throw new Error("Image package exceeds the byte limit");
          hash.update(buffer.subarray(0, count));
        }
      } finally { fs.closeSync(handle); }
      inventory.set(name, [name, "file", `sha256:${hash.digest("hex")}`, stat.mode & 0o777]);
    } else throw new Error("Image package contains a special file");
  }
  walk(root);
  if (!inventory.size) throw new Error("Image package is empty");
  return cloudConfigurationDigest([...inventory.values()].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}
