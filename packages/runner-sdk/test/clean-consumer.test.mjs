import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("packed SDK installs into an isolated npm consumer with no runtime dependency graph", async () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = await mkdtemp(join(tmpdir(), "paperclip-runner-sdk-consumer-"));
  const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8",
    env: { ...process.env, npm_config_cache: join(root, "cache"), npm_config_update_notifier: "false" }, timeout: 30_000 });
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(manifest.optionalDependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
    const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--offline", "--json", "--pack-destination", root], packageRoot));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }));
    run("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed[0].filename)]);
    await writeFile(join(root, "probe.mjs"), `
      import { HARNESS_PROTOCOL_SCHEMA, parseHarnessRequest } from '@paperclipai/runner-sdk/contracts';
      import { serveHarness } from '@paperclipai/runner-sdk/host';
      import { runHarnessProcessConformance } from '@paperclipai/runner-sdk/testing';
      if (typeof serveHarness !== 'function') throw Error('missing host');
      if (typeof runHarnessProcessConformance !== 'function') throw Error('missing test kit');
      console.log(parseHarnessRequest({ schema: HARNESS_PROTOCOL_SCHEMA, id: 1, method: 'snapshot', params: {} }).schema);
    `);
    assert.equal(run(process.execPath, [join(root, "probe.mjs")]).trim(), "paperclip.harness.v1");
    const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
    assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/@paperclipai/runner-sdk"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
