import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRestrictedDir, writeRestrictedFile } from "./restricted-files.js";

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kee216-"));
  cleanupRoots.push(root);
  return root;
}

async function mode(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

// The argument to `mkdir`/`writeFile` is masked by the process umask, so an
// assertion on the argument proves nothing about the file. Every assertion here
// reads the mode back off disk. It checks "no group or other bits" rather than
// an exact 0700/0600: a stricter umask on the developer's machine can only
// remove bits, and a run under umask 0077 is still correct.
function isPrivate(value: number): boolean {
  return (value & 0o077) === 0;
}

describe("ensureRestrictedDir", () => {
  it("creates the directory private, and creates absent parents private too", async () => {
    const root = await createRoot();
    const target = path.join(root, "state", "sessions");

    expect(await ensureRestrictedDir(target)).toEqual([]);

    expect(isPrivate(await mode(target))).toBe(true);
    // A 0700 directory inside a 0755 parent still lists to other accounts; the
    // whole created chain has to be private, which is why `mode` is passed to
    // the recursive mkdir rather than chmod-ed onto the leaf afterwards.
    expect(isPrivate(await mode(path.join(root, "state")))).toBe(true);
  });

  it("narrows a directory an earlier version left world-readable, and says so", async () => {
    const root = await createRoot();
    const target = path.join(root, "sessions");
    // What ACPX's own `ensureDir()` leaves behind: mkdir with no mode, 0755.
    await fs.mkdir(target, { recursive: true, mode: 0o755 });
    expect(isPrivate(await mode(target))).toBe(false);

    const notes = await ensureRestrictedDir(target);

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Narrowed");
    expect(notes[0]).toContain("0755");
    expect(isPrivate(await mode(target))).toBe(true);
  });

  it("is quiet on the second run", async () => {
    const root = await createRoot();
    const target = path.join(root, "sessions");
    await fs.mkdir(target, { recursive: true, mode: 0o755 });

    expect(await ensureRestrictedDir(target)).toHaveLength(1);
    expect(await ensureRestrictedDir(target)).toEqual([]);
  });

  it("reports rather than throws when the path cannot be created", async () => {
    const root = await createRoot();
    // A file where the directory should be: mkdir fails with EEXIST/ENOTDIR.
    const target = path.join(root, "sessions");
    await fs.writeFile(target, "not a directory\n", "utf8");

    const notes = await ensureRestrictedDir(path.join(target, "nested"));

    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("Could not create");
  });
});

describe("writeRestrictedFile", () => {
  it("creates the file private", async () => {
    const root = await createRoot();
    const target = path.join(root, "config.toml");

    await writeRestrictedFile(target, "shell_snapshot = false\n");

    expect(await fs.readFile(target, "utf8")).toBe("shell_snapshot = false\n");
    expect(isPrivate(await mode(target))).toBe(true);
  });

  it("replaces a world-readable file rather than truncating it in place", async () => {
    const root = await createRoot();
    const target = path.join(root, "config.toml");
    // `writeFile`'s `mode` is ignored when the path already exists — the file is
    // truncated and keeps 0644. Without the unlink this assertion fails, which
    // is the whole reason `writeRestrictedFile` exists instead of a bare
    // `writeFile(path, text, { mode })`.
    await fs.writeFile(target, "stale\n", { encoding: "utf8", mode: 0o644 });
    expect(isPrivate(await mode(target))).toBe(false);

    await writeRestrictedFile(target, "fresh\n");

    expect(await fs.readFile(target, "utf8")).toBe("fresh\n");
    expect(isPrivate(await mode(target))).toBe(true);
  });
});
