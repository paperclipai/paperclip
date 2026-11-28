import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { localEnvironment } from "../local-verify/inputs.mjs";

export const repository = fileURLToPath(new URL("../../", import.meta.url));

export function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "local-verify-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  for (const directory of ["scripts/ci", "scripts/local-verify", ".github/scripts"]) {
    cpSync(path.join(repository, directory), path.join(root, directory), { recursive: true });
  }
  for (const file of ["scripts/local-verify.mjs", "scripts/run-vitest-stable.mjs", "scripts/general-server-shard.mjs",
    "scripts/test-line-shard.mjs", "scripts/ci-profile/record.mjs", "turbo.json", ".github/ci-task-matrix.json"]) {
    write(file, readFileSync(path.join(repository, file), "utf8"));
  }
  for (const directory of ["server/src/__tests__", "server/scripts"]) mkdirSync(path.join(root, directory), { recursive: true });
  mkdirSync(path.join(root, "node_modules/.pnpm"), { recursive: true });
  for (const name of ["vitest", "oxc-parser", ".bin"]) {
    symlinkSync(path.join(repository, "node_modules", name), path.join(root, "node_modules", name), "dir");
  }
  for (const file of ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml"]) {
    write(file, readFileSync(path.join(repository, file), "utf8"));
  }
  write(".gitignore", "node_modules\nnode_modules/\n.turbo/\n.env\n");
  write("package.json", JSON.stringify({ name: "local-verification-fixture", private: true, type: "module", packageManager: "pnpm@9.15.4",
    scripts: { verify: "node scripts/local-verify.mjs", "test:run": "vitest run" } }));
  write("vitest.config.mjs", 'export default {test:{projects:["ui","cli"]}};');
  for (const [directory, name] of [["ui", "@paperclipai/ui"], ["cli", "paperclipai"]]) {
    write(`${directory}/vitest.config.mjs`, `export default {test:{name:${JSON.stringify(name)},include:["src/**/*.test.ts"]}};`);
  }
  write("ui/src/leaf.ts", "export const value = 1;\n");
  write("ui/src/other.ts", "export const other = 1;\n");
  write("ui/src/consumer.test.ts", 'import {test,expect} from "vitest"; import {value} from "./leaf"; test("affected consumer",()=>{expect(value).toBeGreaterThan(0);expect(process.env.LOCAL_VERIFY_FLAVOR).not.toBe("fail");});');
  write("ui/src/unrelated.test.ts", 'import {test,expect} from "vitest"; import {other} from "./other"; test("unrelated full-suite control",()=>expect(other).toBe(123456));');
  write("cli/src/independent.test.ts", 'import {test,expect} from "vitest"; test("unchanged consumer project",()=>expect(1).toBe(1));');
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
  const base = git("rev-parse", "HEAD");
  write("ui/src/leaf.ts", "export const value = 2;\n");
  const env = localEnvironment({ ...process.env, FORCE_COLOR: "0" });
  delete env.NODE_TEST_CONTEXT;
  delete env.DATABASE_URL;
  delete env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
  for (const name of Object.keys(env)) if (/^PAPERCLIP_.*_TEST_DATABASE_URL$/.test(name)) delete env[name];
  const run = (args = [], extra = {}) => {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/local-verify.mjs"), "--base", base, ...args], {
      cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.error, undefined);
    return { ...result, text: stripVTControlCharacters(result.stdout + result.stderr) };
  };
  return { root, write, git, base, env, run };
}
