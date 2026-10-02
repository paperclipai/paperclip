import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, expect, it } from "vitest";
import { registerRuntimeCommands, resolvePiProvisioner, resolveRemoteCompanionImporter } from "../commands/runtime.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-cli-runtime-"))); roots.push(root);
  const cli = join(root, "dist/vendor/paperclip-runner/cli"); await mkdir(cli, { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"@paperclipai/server"}');
  await writeFile(join(root, "dist/index.js"), "throw new Error('server must not start during setup resolution')");
  await writeFile(join(cli, "provision-pi.cjs"), "fixture");
  return { root, cli, url: pathToFileURL(join(root, "dist/index.js")).href };
}
it("locates the public server's setup entrypoint without importing its API server", async () => {
  const f = await fixture(); expect(await resolvePiProvisioner(f.url)).toBe(join(f.cli, "provision-pi.cjs"));
});
it("rejects foreign package identity and a setup entrypoint outside that package", async () => {
  const f = await fixture(); const other = await fixture();
  await writeFile(join(f.root, "package.json"), '{"name":"foreign"}');
  await expect(resolvePiProvisioner(f.url)).rejects.toThrow("identity");
  await writeFile(join(f.root, "package.json"), '{"name":"@paperclipai/server"}');
  await rm(join(f.cli, "provision-pi.cjs")); await symlink(join(other.cli, "provision-pi.cjs"), join(f.cli, "provision-pi.cjs"));
  await expect(resolvePiProvisioner(f.url)).rejects.toThrow("escapes");
});
it("provides an explicit Pi-only operator command and rejects other providers before resolution", async () => {
  const program = new Command(); registerRuntimeCommands(program);
  await expect(program.parseAsync(["node", "paperclipai", "runtime", "setup", "untrusted"])).rejects.toThrow("Supported explicit runtime setup");
});

it("resolves the companion importer only inside the actual public server tar layout", async () => {
  const f = await fixture(); const path = join(f.root, "dist/services/native-runtime/remote-pi-companion.js");
  await mkdir(join(f.root, "dist/services/native-runtime"), { recursive: true });
  await writeFile(path, "throw new Error('resolution must not execute importer')");
  expect(await resolveRemoteCompanionImporter(f.url)).toBe(path);
  const other = await fixture(); await rm(path); await symlink(join(other.cli, "provision-pi.cjs"), path);
  await expect(resolveRemoteCompanionImporter(f.url)).rejects.toThrow("escapes");
});
it("requires an explicit digest for the companion import command", async () => {
  const program = new Command(); program.exitOverride().configureOutput({ writeErr() {} }); registerRuntimeCommands(program);
  await expect(program.parseAsync(["node", "paperclipai", "runtime", "import-remote", "/unused"])).rejects.toThrow("sha256");
});
