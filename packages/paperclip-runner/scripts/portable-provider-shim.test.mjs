import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { portableProviderShim } from "./portable-provider-shim.mjs";

for (const node of [false, true]) test(`launcher preserves pack paths through absolute and relative links (node=${node})`, async () => {
  const root = await mkdtemp(join(tmpdir(), "provider shim "));
  try {
    const bin = join(root, "pack/node_modules/.bin");
    await mkdir(bin, { recursive: true });
    await mkdir(join(root, "pack/node_modules/node/bin"), { recursive: true });
    const executable = join(root, "pack/node_modules/provider");
    await writeFile(executable, node ? 'console.log(JSON.stringify(process.argv.slice(2)));' : '#!/bin/sh\nprintf "%s\\n" "$1"\n', { mode: 0o755 });
    await symlink(process.execPath, join(root, "pack/node_modules/node/bin/node"));
    const shim = join(bin, "provider");
    await writeFile(shim, portableProviderShim("provider", { node }), { mode: 0o755 });
    await symlink(shim, join(root, "absolute"));
    await symlink("absolute", join(root, "relative"));
    for (const command of [shim, join(root, "absolute"), join(root, "relative")]) {
      const output = execFileSync(command, ["argument with spaces"], { encoding: "utf8", cwd: "/" }).trim();
      assert.equal(output, node ? '["argument with spaces"]' : "argument with spaces");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
