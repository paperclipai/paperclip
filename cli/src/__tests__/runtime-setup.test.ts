import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveCursorProvisioner } from "../commands/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-public-setup-")));
  roots.push(root);
  await mkdir(join(root, "dist/vendor/paperclip-runner/cli"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  await writeFile(join(root, "dist/index.js"), "throw new Error('must not import server');");
  const provisioner = join(root, "dist/vendor/paperclip-runner/cli/provision-cursor.cjs");
  await writeFile(provisioner, "fixture");
  return { root, provisioner, url: pathToFileURL(join(root, "dist/index.js")).href };
}

it("resolves the public provisioner without starting the server", async () => {
  const f = await fixture();
  expect(await resolveCursorProvisioner(f.url)).toBe(f.provisioner);
});

it("rejects repository layouts and wrong package identities", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "src")); await writeFile(join(f.root, "src/index.ts"), "fixture");
  await expect(resolveCursorProvisioner(pathToFileURL(join(f.root, "src/index.ts")).href)).rejects.toThrow("published server layout");
  await writeFile(join(f.root, "package.json"), JSON.stringify({ name: "untrusted" }));
  await expect(resolveCursorProvisioner(f.url)).rejects.toThrow("identity is invalid");
});

it("rejects a provisioner linked outside the installed package", async () => {
  const f = await fixture(); const other = await fixture();
  await rm(f.provisioner); await symlink(other.provisioner, f.provisioner);
  await expect(resolveCursorProvisioner(f.url)).rejects.toThrow("escapes");
});
