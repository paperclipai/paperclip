import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTestHome } from "./remove-test-home.js";

const homes: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "remove-test-home-"));
  homes.push(home);
  return home;
}

/**
 * The tree a native session leaves behind: a runtime-context bundle whose
 * files are read-only and whose directories are read-only too, the way
 * `makeDirectoriesReadOnly` publishes it under the instance root.
 */
function leaveReadOnlyBundle(home: string): string {
  const bundle = path.join(home, "instances", "default", "runtime-context-assets", "bundles", "digest");
  const nested = path.join(bundle, "skills", "assigned");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(bundle, "AGENTS.md"), "# instructions\n", { mode: 0o444 });
  fs.writeFileSync(path.join(nested, "SKILL.md"), "# skill\n", { mode: 0o444 });
  fs.chmodSync(nested, 0o555);
  fs.chmodSync(path.dirname(nested), 0o555);
  fs.chmodSync(bundle, 0o555);
  return bundle;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    if (fs.existsSync(home)) {
      // Leave nothing behind even if an assertion failed partway.
      fs.chmodSync(home, 0o700);
      removeTestHome(home);
    }
  }
});

describe("removeTestHome", () => {
  it("removes a home whose runtime-context bundle directories are read-only", () => {
    const home = makeHome();
    const bundle = leaveReadOnlyBundle(home);
    fs.writeFileSync(path.join(home, "instances", "default", "paperclip.json"), "{}\n");

    // The plain removal the setup file used to run is what fails in CI.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      expect(() => fs.rmSync(home, { recursive: true, force: true })).toThrow(/EACCES|EPERM|ENOTEMPTY/);
      expect(fs.existsSync(bundle)).toBe(true);
    }

    removeTestHome(home);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("removes an ordinary home and tolerates one that is already gone", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, "instances", "default"), { recursive: true });
    fs.writeFileSync(path.join(home, "instances", "default", "paperclip.json"), "{}\n");
    const error = Object.assign(new Error("unrelated nonempty directory"), { code: "ENOTEMPTY" });
    const removal = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw error; });
    const permissionChange = vi.spyOn(fs, "chmodSync");
    try {
      expect(() => removeTestHome(home)).toThrow(error);
      expect(removal).toHaveBeenCalledTimes(1);
      expect(permissionChange).not.toHaveBeenCalled();
    } finally {
      removal.mockRestore();
      permissionChange.mockRestore();
    }
    removeTestHome(home);
    expect(fs.existsSync(home)).toBe(false);
    expect(() => removeTestHome(home)).not.toThrow();
  });

  // Windows keeps no Unix mode bits (chmod only toggles the read-only
  // attribute, so the 0o555 assertion cannot hold) and a directory symlink
  // can need elevated privileges there. POSIX-only, like the suite's other
  // permission tests.
  it.skipIf(process.platform === "win32")("does not follow a symlink out of the home while making directories writable", () => {
    const home = makeHome();
    const outside = makeHome();
    const guarded = path.join(outside, "guarded");
    fs.mkdirSync(guarded);
    fs.writeFileSync(path.join(guarded, "keep.txt"), "keep\n");
    fs.chmodSync(guarded, 0o555);
    leaveReadOnlyBundle(home);
    fs.symlinkSync(outside, path.join(home, "link-out"), "dir");

    removeTestHome(home);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(path.join(guarded, "keep.txt"))).toBe(true);
    expect(fs.statSync(guarded).mode & 0o777).toBe(0o555);
    fs.chmodSync(guarded, 0o700);
  });
});
