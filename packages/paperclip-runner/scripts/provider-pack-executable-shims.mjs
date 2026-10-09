import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

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

export function writePortableCopilotShims(packRoot) {
  const packRequire = createRequire(join(packRoot, "package.json"));
  // Optional platform packages expose native .bin entries. Rewrite only the
  // installed entries, and resolve their pinned executable without running it.
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
    const name = `copilot-${platform}`;
    if (!existsSync(join(packRoot, "node_modules", ".bin", name))) continue;
    const executable = packRequire.resolve(`@github/${name}`);
    writePortableExecutableShim(
      packRoot,
      name,
      relative(realpathSync(join(packRoot, "node_modules")), realpathSync(executable)),
    );
  }
}
