import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cursorRuntimeCachePath, resolveCursorDistributionRoot } from "./cursor-runtime-cache.js";

const roots: string[] = [];
const pin = "a".repeat(64);
afterEach(() => { vi.unstubAllEnvs(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function root() { const path = mkdtempSync(join(tmpdir(), "cursor-runtime-cache-")); roots.push(path); return path; }

it("uses the OS account instead of provider-controlled HOME or XDG paths", () => {
  vi.stubEnv("HOME", "/untrusted/workspace");
  vi.stubEnv("XDG_DATA_HOME", "/untrusted/data");
  expect(cursorRuntimeCachePath(pin, "linux", "x64")).toBe(join(userInfo().homedir, ".paperclip/runtimes/cursor/linux-x64", pin));
});

it("finds user assets when the npm installation is read-only, without writing into it", () => {
  const packageRoot = root();
  chmodSync(packageRoot, 0o555);
  try {
    expect(resolveCursorDistributionRoot(join(packageRoot, "provider-assets/cursor"), pin, "linux", "x64"))
      .toBe(cursorRuntimeCachePath(pin, "linux", "x64"));
  } finally { chmodSync(packageRoot, 0o700); }
});

it("keeps packaged image assets authoritative and rejects broken assets without fallback", () => {
  const assets = root(); const packaged = join(assets, "linux-x64");
  mkdirSync(packaged);
  expect(resolveCursorDistributionRoot(assets, pin, "linux", "x64")).toBe(packaged);
  rmSync(packaged, { recursive: true }); writeFileSync(packaged, "not a runtime");
  expect(() => resolveCursorDistributionRoot(assets, pin, "linux", "x64")).toThrow("real directory");
  rmSync(packaged); symlinkSync(root(), packaged);
  expect(() => resolveCursorDistributionRoot(assets, pin, "linux", "x64")).toThrow("real directory");
});

it("separates closure versions and refuses linked cache parents", () => {
  const home = root();
  expect(cursorRuntimeCachePath(pin, "darwin", "arm64", home)).not.toBe(cursorRuntimeCachePath("b".repeat(64), "darwin", "arm64", home));
  symlinkSync(root(), join(home, ".paperclip"));
  expect(() => cursorRuntimeCachePath(pin, "darwin", "arm64", home)).toThrow("real directories");
});
