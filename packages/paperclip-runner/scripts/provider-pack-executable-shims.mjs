import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pnpmStoreEntryOf, removePnpmStoreEntries } from "./provider-pack-runtime-tree.mjs";

export function writePortableExecutableShim(packRoot, name, executable) {
  const shimPath = join(packRoot, "node_modules", ".bin", name);
  writeFileSync(
    shimPath,
    [
      "#!/bin/sh",
      "set -eu",
      'basedir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      `exec "$basedir/../${executable}" "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shimPath, 0o755);
}

const sha256 = path => createHash("sha256").update(readFileSync(path)).digest("hex");

export function writePortableCopilotShims(packRoot) {
  const packRequire = createRequire(join(packRoot, "package.json"));
  const nodeModules = realpathSync(join(packRoot, "node_modules"));
  // Optional platform packages expose native .bin entries. Rewrite only the
  // installed entries, and resolve their pinned executable without running it.
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
    const name = `copilot-${platform}`;
    if (!existsSync(join(packRoot, "node_modules", ".bin", name))) continue;
    const executable = realpathSync(packRequire.resolve(`@github/${name}`));
    // The pack's verified Copilot asset is built from the same pinned npm
    // archive. When its executable is byte-identical, keep the command name but
    // point it at that asset and drop the second ~160 MB copy from node_modules.
    const asset = join(packRoot, "provider-assets", "copilot", platform, "copilot");
    if (existsSync(asset) && sha256(asset) === sha256(executable)) {
      const entry = pnpmStoreEntryOf(packRoot, executable);
      writePortableExecutableShim(packRoot, name, relative(nodeModules, realpathSync(asset)));
      removePnpmStoreEntries(packRoot, [entry]);
      continue;
    }
    writePortableExecutableShim(packRoot, name, relative(nodeModules, executable));
  }
}
