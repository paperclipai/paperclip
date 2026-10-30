import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writePortableCopilotShims } from "./provider-pack-executable-shims.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-shims-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pack = join(root, "temporary pack");
  mkdirSync(join(pack, "node_modules", ".bin"), { recursive: true });
  writeFileSync(join(pack, "package.json"), '{"type":"module"}');
  return { root, pack };
}

for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
  test(`relocates the installed ${platform} Copilot command and preserves arguments and exit status`, (t) => {
    const { root, pack } = fixture(t);
    const name = `copilot-${platform}`;
    const installed = join(pack, "node_modules", "@github", name);
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({
      name: `@github/${name}`, exports: { ".": "./copilot" }, bin: { [name]: "copilot" },
    }));
    // A provider-free executable proves relocation without invoking a real CLI.
    writeFileSync(join(installed, "copilot"), '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 17\n', { mode: 0o755 });
    const shim = join(pack, "node_modules", ".bin", name);
    writeFileSync(shim, `#!/bin/sh\nexport NODE_PATH="${pack}/node_modules"\nexit 99\n`);

    writePortableCopilotShims(pack);
    assert.equal(readFileSync(shim, "utf8").includes(root), false);
    const relocated = join(root, "relocated pack");
    renameSync(pack, relocated);
    const args = ["argument with spaces", "", "$(not-a-command)"];
    const result = spawnSync(join(relocated, "node_modules", ".bin", name), args, {
      cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 17);
    assert.equal(result.stdout, args.join("\n") + "\n");
    assert.equal(result.stderr, "");
  });
}

test("does not create commands for absent optional platform packages", (t) => {
  const { pack } = fixture(t);
  writePortableCopilotShims(pack);
  for (const platform of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
    assert.equal(existsSync(join(pack, "node_modules", ".bin", `copilot-${platform}`)), false);
  }
});

test("fails when an installed command has no matching package", (t) => {
  const { pack } = fixture(t);
  writeFileSync(join(pack, "node_modules", ".bin", "copilot-linux-x64"), "invalid old shim");
  assert.throws(() => writePortableCopilotShims(pack), { code: "MODULE_NOT_FOUND" });
});

function pnpmCopilot(pack, platform, executable) {
  const name = `copilot-${platform}`;
  const entry = `@github+${name}@1.0.88`;
  const installed = join(pack, "node_modules", ".pnpm", entry, "node_modules", "@github", name);
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, "package.json"), JSON.stringify({
    name: `@github/${name}`, exports: { ".": "./copilot" }, bin: { [name]: "copilot" },
  }));
  writeFileSync(join(installed, "copilot"), executable, { mode: 0o755 });
  mkdirSync(join(pack, "node_modules", "@github"), { recursive: true });
  symlinkSync(`../.pnpm/${entry}/node_modules/@github/${name}`, join(pack, "node_modules", "@github", name));
  writeFileSync(join(pack, "node_modules", ".bin", name), "#!/bin/sh\nexit 99\n");
  return { name, entry: join(pack, "node_modules", ".pnpm", entry) };
}

function providerAsset(pack, platform, executable) {
  const directory = join(pack, "provider-assets", "copilot", platform);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "copilot"), executable, { mode: 0o755 });
}

test("points the Copilot command at the identical provider asset and drops the npm copy", (t) => {
  const { root, pack } = fixture(t);
  const executable = '#!/bin/sh\nprintf "asset %s\\n" "$@"\nexit 17\n';
  const { name, entry } = pnpmCopilot(pack, "linux-x64", executable);
  providerAsset(pack, "linux-x64", executable);

  writePortableCopilotShims(pack);
  assert.equal(existsSync(entry), false);
  assert.equal(existsSync(join(pack, "node_modules", "@github")), false);
  const relocated = join(root, "relocated pack");
  renameSync(pack, relocated);
  const result = spawnSync(join(relocated, "node_modules", ".bin", name), ["one argument"], {
    cwd: root, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.status, 17);
  assert.equal(result.stdout, "asset one argument\n");
});

test("keeps the npm Copilot copy when the provider asset differs", (t) => {
  const { pack } = fixture(t);
  const { name, entry } = pnpmCopilot(pack, "linux-x64", "#!/bin/sh\necho npm\n");
  providerAsset(pack, "linux-x64", "#!/bin/sh\necho asset\n");

  writePortableCopilotShims(pack);
  assert.equal(existsSync(entry), true);
  const result = spawnSync(join(pack, "node_modules", ".bin", name), [], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.stdout, "npm\n");
});
