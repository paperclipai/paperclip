import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cloudConfigurationDigest } from "./cloud-configuration-evidence.js";

export function cloudBundledPackageDigest(packageRoot: string): string {
  const root = fs.realpathSync(packageRoot);
  const inventory: Array<[string, string, string, number]> = [];
  let bytes = 0;
  let entries = 0;
  function walk(directory: string, relative = "") {
    if (relative.split("/").length > 32) throw new Error("Image package exceeds the directory depth limit");
    for (const name of fs.readdirSync(directory).sort()) {
      if (++entries > 10_000) throw new Error("Image package exceeds the entry limit");
      const local = relative ? `${relative}/${name}` : name;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        const contained = path.relative(root, target);
        if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) throw new Error("Image package symlink escapes its package");
        const targetStat = fs.statSync(target);
        if (!targetStat.isFile() && !targetStat.isDirectory()) throw new Error("Image package symlink has an unsupported target");
        inventory.push([local, "link", fs.readlinkSync(file), stat.mode & 0o777]);
      } else if (stat.isDirectory()) walk(file, local);
      else if (stat.isFile()) {
        if (bytes + stat.size > 256 * 1024 * 1024) throw new Error("Image package exceeds the byte limit");
        const handle = fs.openSync(file, "r");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(65_536);
        try {
          while (true) {
            const count = fs.readSync(handle, buffer);
            if (!count) break;
            bytes += count;
            if (bytes > 256 * 1024 * 1024) throw new Error("Image package exceeds the byte limit");
            hash.update(buffer.subarray(0, count));
          }
        } finally { fs.closeSync(handle); }
        inventory.push([local, "file", `sha256:${hash.digest("hex")}`, stat.mode & 0o777]);
      } else throw new Error("Image package contains a special file");
    }
  }
  walk(root);
  if (!inventory.length) throw new Error("Image package is empty");
  return cloudConfigurationDigest(inventory);
}
