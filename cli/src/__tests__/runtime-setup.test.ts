import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveAntigravityProvisioner, resolveCursorProvisioner, resolveKimiProvisioner } from "../commands/runtime.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(provider = "cursor") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-public-setup-")));
  roots.push(root);
  await mkdir(join(root, "dist/vendor/paperclip-runner/cli"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@paperclipai/server" }));
  await writeFile(join(root, "dist/index.js"), "throw new Error('must not import server');");
  const provisioner = join(root, `dist/vendor/paperclip-runner/cli/provision-${provider}.cjs`);
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


it("resolves only Kimi's installed provisioner and rejects a redirected setup", async () => {
  const f = await fixture("kimi");
  expect(await resolveKimiProvisioner(f.url)).toBe(f.provisioner);
  const other = await fixture("kimi");
  await rm(f.provisioner); await symlink(other.provisioner, f.provisioner);
  await expect(resolveKimiProvisioner(f.url)).rejects.toThrow("escapes");
  await writeFile(join(other.root, "package.json"), JSON.stringify({ name: "untrusted" }));
  await expect(resolveKimiProvisioner(other.url)).rejects.toThrow("identity is invalid");
});

it("resolves Antigravity setup from the public server without importing it", async () => {
  const f = await fixture("antigravity");
  expect(await resolveAntigravityProvisioner(f.url)).toBe(f.provisioner);
});

it("rejects an Antigravity provisioner outside the installed server", async () => {
  const f = await fixture("antigravity"); const other = await fixture("antigravity");
  await rm(f.provisioner); await symlink(other.provisioner, f.provisioner);
  await expect(resolveAntigravityProvisioner(f.url)).rejects.toThrow("escapes");
  await expect(resolveAntigravityProvisioner(`${f.url}?redirect=1`)).rejects.toThrow("installed Paperclip server");
});
