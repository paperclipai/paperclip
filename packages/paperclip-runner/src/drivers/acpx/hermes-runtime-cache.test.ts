import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hermesRuntimeCachePath, resolveHermesDistributionRoot } from "./hermes-runtime-cache.js";

const digest = "1".repeat(64);
const roots: string[] = [];
const root = () => { const path = realpathSync(mkdtempSync(join(tmpdir(), "hermes-runtime-cache-"))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("Hermes explicit setup cache", () => {
  it("uses the OS account despite a provider HOME override", () => {
    const original = process.env.HOME;
    try {
      process.env.HOME = root();
      expect(hermesRuntimeCachePath(digest, "darwin", "arm64")).toBe(join(userInfo().homedir, ".paperclip/runtimes/hermes/darwin-arm64", digest));
    } finally { if (original === undefined) delete process.env.HOME; else process.env.HOME = original; }
  });
  it("uses the cache only when package assets are absent", () => {
    const home = root(); const assets = join(root(), "provider-assets/hermes");
    expect(resolveHermesDistributionRoot(assets, digest, "linux", "x64", home)).toBe(hermesRuntimeCachePath(digest, "linux", "x64", home));
    const packaged = join(assets, "linux-x64"); mkdirSync(packaged, { recursive: true });
    expect(resolveHermesDistributionRoot(assets, digest, "linux", "x64", home)).toBe(packaged);
  });
  it("does not fall back around corrupt or linked packaged assets", () => {
    const home = root(); const assets = root(); const target = join(assets, "linux-x64");
    writeFileSync(target, "invalid");
    expect(() => resolveHermesDistributionRoot(assets, digest, "linux", "x64", home)).toThrow("packaged runtime");
    rmSync(target); symlinkSync(root(), target);
    expect(() => resolveHermesDistributionRoot(assets, digest, "linux", "x64", home)).toThrow("packaged runtime");
  });
  it("rejects cache links, foreign targets and malformed identity", () => {
    const home = root(); symlinkSync(root(), join(home, ".paperclip"));
    expect(() => hermesRuntimeCachePath(digest, "linux", "x64", home)).toThrow("real directories");
    expect(() => hermesRuntimeCachePath(digest, "darwin", "x64", root())).toThrow("identity");
    expect(() => hermesRuntimeCachePath("unreviewed", "linux", "x64", root())).toThrow("identity");
    expect(() => hermesRuntimeCachePath(digest, "linux", "x64", "/tmp/../tmp")).toThrow("identity");
  });
});
