import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(runnerRoot, "package.json"), "utf8"));
const pnpmScript = process.env.npm_execpath;
const pnpm = pnpmScript?.replaceAll("\\", "/").endsWith("/pnpm.cjs")
  ? [process.execPath, pnpmScript] : [process.platform === "win32" ? "pnpm.cmd" : "pnpm"];

// The full clean-consumer check packs this Runner package, installs it offline,
// then launches defaultCapabilityRunnerdBinary() without a binary override.
// This small actual pack/install regression isolates pnpm's mode normalization,
// including the absent alternate-platform executable and a negative control.
for (const declared of [true, false]) {
  test(`pnpm installed native mode ${declared ? "honors executableFiles" : "rejects an undeclared executable"}`,
    { skip: process.platform === "win32" ? "POSIX executable-bit contract" : false }, async t => {
      const root = await mkdtemp(join(tmpdir(), "runner-executable-pack-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const source = join(root, "source"), output = join(root, "artifacts"), home = join(root, "home");
      const consumer = join(root, "consumer");
      for (const dir of [join(source, "dist/bin"), output, home, consumer]) await mkdir(dir, { recursive: true });
      for (const file of ["user.npmrc", "global.npmrc"]) await writeFile(join(home, file), "");
      const env = { PATH: process.env.PATH, HOME: home, TMPDIR: root, CI: "true",
        npm_config_userconfig: join(home, "user.npmrc"), npm_config_globalconfig: join(home, "global.npmrc"),
        npm_config_cache: join(home, "cache"), npm_config_ignore_scripts: "true", npm_config_offline: "true",
        npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
      const run = (command, args, cwd) => execFileSync(command, args,
        { cwd, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
      assert.equal(run(pnpm[0], [...pnpm.slice(1), "--version"], source).trim(), "9.15.4");
      assert.deepEqual(manifest.publishConfig.executableFiles,
        ["./dist/bin/paperclip-runnerd", "./dist/bin/paperclip-runnerd.exe"]);
      await writeFile(join(source, "package.json"), JSON.stringify({
        name: "runner-executable-fixture", version: "1.0.0", files: ["dist"],
        ...(declared ? { publishConfig: manifest.publishConfig } : {}),
      }));
      // Deliberately omit the Windows binary. Packing a platform-specific
      // package must tolerate the other executableFiles entry being absent.
      const executable = join(source, "dist/bin/paperclip-runnerd");
      await writeFile(executable, "#!/bin/sh\nprintf 'packaged-native-fixture\\n'\n");
      await chmod(executable, 0o755);
      run(pnpm[0], [...pnpm.slice(1), "pack", "--pack-destination", output], source);
      const archives = (await readdir(output)).filter(name => name.endsWith(".tgz"));
      assert.equal(archives.length, 1);
      await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "runner-consumer", private: true }));
      run("npm", ["install", "--offline", "--ignore-scripts", "--package-lock=false", join(output, archives[0])], consumer);
      const installed = join(consumer, "node_modules/runner-executable-fixture/dist/bin/paperclip-runnerd");
      assert.deepEqual(await readFile(installed), await readFile(executable));
      if (declared) {
        await access(installed, constants.X_OK);
        assert.equal(run(installed, [], consumer).trim(), "packaged-native-fixture");
      } else {
        await assert.rejects(access(installed, constants.X_OK), { code: "EACCES" });
      }
    });
}
