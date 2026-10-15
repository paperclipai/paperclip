import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInstalledProviderAuthority } from "./installed-provider-authority.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(name = "@paperclipai/server") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "installed-acpx-authority-")));
  roots.push(root);
  const directory = join(root, "dist/vendor/paperclip-runner/drivers/acpx");
  await mkdir(directory, { recursive: true });
  const module = join(directory, "installation-integrity.js");
  await writeFile(module, "export {};\n");
  const manifest = join(root, "package.json");
  await writeFile(manifest, JSON.stringify({ name }));
  return { root, module, manifest };
}

describe("installed provider authority", () => {
  it("derives the owning server only from the normal installed verifier layout", async () => {
    const f = await fixture();
    expect(resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toEqual({ root: f.root, manifest: f.manifest });
    expect(resolveInstalledProviderAuthority(pathToFileURL(join(f.root, "src/drivers/acpx/installation-integrity.ts")).href)).toBeUndefined();
    expect(resolveInstalledProviderAuthority(pathToFileURL(join(f.root, "dist/drivers/acpx/installation-integrity.js")).href)).toBeUndefined();
  });

  it("rejects a substituted package owner", async () => {
    const f = await fixture("unrelated-package");
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow("owning server package");
  });

  it("rejects a symlinked manifest before adopting its declarations", async () => {
    const f = await fixture();
    const other = join(f.root, "other.json");
    await writeFile(other, JSON.stringify({ name: "@paperclipai/server" }));
    await rm(f.manifest);
    await symlink(other, f.manifest);
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow();
  });

  it("rejects a redirected verifier directory", async () => {
    const f = await fixture();
    const old = join(f.root, "dist/vendor/paperclip-runner/drivers/acpx");
    const other = join(f.root, "other");
    await mkdir(other);
    await writeFile(join(other, "installation-integrity.js"), "export {};\n");
    await rm(old, { recursive: true });
    await symlink(other, old);
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow("package layout");
  });

  it.each(["", " ".repeat(256 * 1024 + 1)])("rejects unbounded or empty owner metadata", async contents => {
    const f = await fixture();
    await writeFile(f.manifest, contents);
    expect(() => resolveInstalledProviderAuthority(pathToFileURL(f.module).href)).toThrow("bounded regular file");
  });
});
