import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { createIsolatedTestHome } from "./helpers/isolated-test-home.js";

afterEach(() => vi.restoreAllMocks());

it("removes immutable cache directories at process exit even after filesystem spies change", () => {
  const helper = fileURLToPath(new URL("./helpers/isolated-test-home.ts", import.meta.url));
  const result = execFileSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", `
    import fs from 'node:fs';
    import path from 'node:path';
    const { createIsolatedTestHome } = await import(process.argv[1]);
    const owned = createIsolatedTestHome();
    const cache = path.join(owned.home, 'runtime-skills', 'immutable');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'SKILL.md'), 'read-only fixture');
    fs.chmodSync(path.join(cache, 'SKILL.md'), 0o444);
    fs.chmodSync(cache, 0o555);
    process.once('exit', owned.cleanup);
    fs.rmSync = () => { throw Object.assign(new Error('simulated read-only filesystem'), { code: 'EACCES' }); };
    console.log(owned.home);
  `, helper], { encoding: "utf8" });
  const home = result.trim();
  expect(path.basename(home)).toMatch(/^paperclip-vitest-home-/);
  expect(fs.existsSync(home)).toBe(false);
});

it("never follows links from an owned home into another directory", () => {
  const owned = createIsolatedTestHome();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cleanup-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "private"), "retained");
    fs.chmodSync(outside, 0o555);
    fs.symlinkSync(outside, path.join(owned.home, "external"));
    owned.cleanup();
    expect(fs.existsSync(owned.home)).toBe(false);
    expect(fs.readFileSync(path.join(outside, "private"), "utf8")).toBe("retained");
    expect(fs.statSync(outside).mode & 0o777).toBe(0o555);
  } finally {
    fs.chmodSync(outside, 0o700);
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it("refuses a replaced home instead of deleting its replacement", () => {
  const owned = createIsolatedTestHome();
  const retained = `${owned.home}-retained`;
  fs.renameSync(owned.home, retained);
  fs.symlinkSync(retained, owned.home);
  try {
    expect(owned.cleanup).toThrow("Refusing to clean a replaced isolated test home");
    expect(fs.statSync(retained).isDirectory()).toBe(true);
  } finally {
    fs.unlinkSync(owned.home);
    fs.rmSync(retained, { recursive: true, force: true });
  }
});
