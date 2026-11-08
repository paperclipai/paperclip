import { afterEach, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { materializeWindowsCodexRuntime } from "./windows-codex-runtime.js";

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "paperclip-native-codex-cache-"));
  const source = join(root, "source"), cache = join(root, "cache");
  mkdirSync(source);
  const binary = join(source, "codex.exe");
  writeFileSync(binary, "official runtime fixture");
  writeFileSync(join(source, "codex-code-mode-host.exe"), "official helper fixture");
  writeFileSync(join(source, "auth.json"), "must not be copied");
  return { binary, cache };
}

it("copies only executable resources and reuses a verified generation", () => {
  const f = fixture(), cached = materializeWindowsCodexRuntime(f.binary, f.cache);
  expect(cached).not.toBe(f.binary);
  expect(materializeWindowsCodexRuntime(f.binary, f.cache)).toBe(cached);
  expect(readdirSync(dirname(cached)).sort()).toEqual(["codex-code-mode-host.exe", "codex.exe", "runtime.json"]);
  expect(readFileSync(cached, "utf8")).toBe("official runtime fixture");
});
it("refuses a changed cached executable instead of running it", () => {
  const f = fixture(), cached = materializeWindowsCodexRuntime(f.binary, f.cache);
  writeFileSync(cached, "changed");
  expect(() => materializeWindowsCodexRuntime(f.binary, f.cache)).toThrow("Cached native Codex runtime changed");
});
it("refuses a cached hard link", () => {
  const f = fixture(), cached = materializeWindowsCodexRuntime(f.binary, f.cache);
  linkSync(cached, join(root, "alias.exe"));
  expect(() => materializeWindowsCodexRuntime(f.binary, f.cache)).toThrow("Cached native Codex runtime changed");
});
it("refuses directory links in its cache ancestry", () => {
  const f = fixture(), elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
  symlinkSync(elsewhere, f.cache, process.platform === "win32" ? "junction" : "dir");
  expect(() => materializeWindowsCodexRuntime(f.binary, f.cache)).toThrow("directory links");
});
it("creates another generation after a source update", () => {
  const f = fixture(), previous = materializeWindowsCodexRuntime(f.binary, f.cache);
  writeFileSync(f.binary, "new official runtime fixture");
  const next = materializeWindowsCodexRuntime(f.binary, f.cache);
  expect(next).not.toBe(previous);
  expect(readFileSync(previous, "utf8")).toBe("official runtime fixture");
});
