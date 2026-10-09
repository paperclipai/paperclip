import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { COPILOT_DISTRIBUTIONS } from "./materialize-copilot-binary.mjs";

const runnerRoot = fileURLToPath(new URL("../", import.meta.url));
const serverRoot = fileURLToPath(new URL("../../../server/", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const distribution = COPILOT_DISTRIBUTIONS[target];
const require = createRequire(import.meta.url);
const helpers = ["install-copilot-assets.mjs", "materialize-copilot-binary.mjs", "copilot-inner-distribution.mjs"];

function invoke(script) {
  return spawnSync(process.execPath, [script], {
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: tmpdir() },
    encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024,
  });
}

function succeeded(result, status) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(status));
}

for (const owner of ["runner", "server"]) {
  test(`fresh ${owner} package installs verified assets without a workspace or qualification override`, {
    skip: !distribution && "Copilot does not advertise this platform", timeout: 180_000,
  }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "copilot-install-package-")));
    try {
      const native = dirname(require.resolve(distribution.packageName));
      await mkdir(join(root, "node_modules/@github"), { recursive: true });
      await symlink(native, join(root, "node_modules", distribution.packageName), "dir");
      await writeFile(join(root, "package.json"), JSON.stringify({
        name: owner === "server" ? "@paperclipai/server" : "@paperclipai/paperclip-runner", type: "module",
      }));
      const runtimeRoot = owner === "server" ? join(root, "dist/vendor/paperclip-runner") : join(root, "dist");
      // Compile the actual installation closure into a published package layout.
      // A clean static-check checkout has no prebuilt dist directory.
      await build({
        entryPoints: [join(runnerRoot, "src/drivers/acpx/copilot-installation.ts"),
          join(runnerRoot, "src/drivers/acpx/qualified-profiles.ts")],
        outbase: join(runnerRoot, "src"), outdir: runtimeRoot,
        bundle: true, platform: "node", format: "esm", target: "node24",
        logLevel: "silent",
      });
      const scriptRoot = owner === "server" ? join(root, "dist") : join(root, "scripts");
      await mkdir(scriptRoot, { recursive: true });
      for (const name of helpers) await cp(join(runnerRoot, "scripts", name), join(scriptRoot, name));
      let installer = join(scriptRoot, "install-copilot-assets.mjs");
      if (owner === "server") {
        await mkdir(join(root, "scripts"));
        installer = join(root, "scripts/install-copilot-assets.mjs");
        await cp(join(serverRoot, "scripts/install-copilot-assets.mjs"), installer);
      }
      succeeded(invoke(installer), "installed");
      succeeded(invoke(installer), "verified-existing");
      const assets = join(root, "provider-assets");
      const closure = join(assets, "copilot", target, ".paperclip-copilot-closure.json");
      const original = await readFile(closure);
      const corrupted = JSON.parse(original.toString());
      corrupted.entries[0].sha256 = "0".repeat(64);
      await writeFile(closure, JSON.stringify(corrupted));
      const failure = invoke(installer);
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr, /COPILOT_INSTALLATION_INVALID/);
      assert.notDeepEqual(await readFile(closure), original, "failed verification must retain its evidence");
      await writeFile(closure, original);
      succeeded(invoke(installer), "verified-existing");
      const retained = join(root, "retained-assets");
      const outside = join(root, "outside");
      await mkdir(outside);
      await rename(assets, retained);
      await symlink(outside, assets, "dir");
      const linked = invoke(installer);
      assert.notEqual(linked.status, 0);
      assert.match(linked.stderr, /must not redirect through links/);
      await assert.rejects(readFile(join(outside, "copilot", target, "copilot")), { code: "ENOENT" });
      await rm(assets);
      await rename(retained, assets);
      succeeded(invoke(installer), "verified-existing");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("an unbuilt source workspace defers installation; a published package with missing build output fails", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "copilot-install-bootstrap-")));
  try {
    const server = join(root, "server");
    await mkdir(join(server, "scripts"), { recursive: true });
    const script = join(server, "scripts/install-copilot-assets.mjs");
    await cp(join(serverRoot, "scripts/install-copilot-assets.mjs"), script);
    assert.notEqual(invoke(script).status, 0);
    await mkdir(join(server, "src/services"), { recursive: true });
    await writeFile(join(server, "src/services/copilot-connection-probe.ts"), "// source workspace\n");
    assert.notEqual(invoke(script).status, 0);
    await writeFile(join(root, "pnpm-workspace.yaml"), "packages: [server]\n");
    succeeded(invoke(script), "source-workspace-pending-build");
    await assert.rejects(readFile(join(server, "provider-assets/copilot", target, "copilot")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
