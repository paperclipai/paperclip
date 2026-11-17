import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { copyOwnedNodeRuntime } from "./owned-node-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("copies writable host artifacts into an owned closure without changing the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-node-test-")); roots.push(root);
  const bin = join(root, "host", "bin"), lib = join(root, "host", "lib");
  await mkdir(bin, { recursive: true }); await mkdir(lib);
  const source = join(bin, "node"), library = join(lib, "libnode.137.dylib");
  await writeFile(source, "synthetic Node artifact"); await chmod(source, 0o777);
  await writeFile(library, "synthetic library"); await chmod(library, 0o666);
  await writeFile(join(lib, "unrelated.dylib"), "not in the Node closure");
  const sourceMode = (await stat(source)).mode, libraryMode = (await stat(library)).mode;

  const owned = await copyOwnedNodeRuntime(join(root, "owned"), source);

  expect(owned.libraries).toEqual([join(root, "owned", "libnode.137.dylib")]);
  expect(await readFile(owned.executable)).toEqual(await readFile(source));
  expect(await readFile(owned.libraries[0]!)).toEqual(await readFile(library));
  expect((await lstat(owned.executable)).isSymbolicLink()).toBe(false);
  if (process.platform !== "win32") {
    expect((await stat(owned.executable)).mode & 0o777).toBe(0o700);
    expect((await stat(owned.libraries[0]!)).mode & 0o777).toBe(0o600);
  }
  expect((await stat(source)).mode).toBe(sourceMode);
  expect((await stat(library)).mode).toBe(libraryMode);
});

it("copies the real host Node bytes without executing the runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-node-test-")); roots.push(root);
  const owned = await copyOwnedNodeRuntime(root);
  expect((await readFile(owned.executable)).equals(await readFile(process.execPath))).toBe(true);
  expect((await lstat(owned.executable)).isFile()).toBe(true);
  if (process.platform !== "win32") expect((await stat(owned.executable)).mode & 0o022).toBe(0);
});

it("rejects a broken adjacent library directory instead of returning an incomplete closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "owned-node-test-")); roots.push(root);
  const bin = join(root, "host", "bin"), lib = join(root, "host", "lib");
  await mkdir(bin, { recursive: true });
  const source = join(bin, "node");
  await writeFile(source, "synthetic Node artifact");
  await writeFile(lib, "a file cannot be the library directory");
  await expect(copyOwnedNodeRuntime(join(root, "owned"), source)).rejects.toMatchObject({
    message: `Cannot read Node fixture libraries at ${lib}`,
    cause: { code: "ENOTDIR" },
  });
});
