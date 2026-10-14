import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { installedDaytonaPluginKeys, verifyInstalledDaytonaPlugin, type InstalledDaytonaPluginAuthority } from "./installed-daytona-plugin.js";
import { buildPaperclipServerEnvironment } from "./harness-env.js";
import { setupLiveFixtures } from "./live-fixtures.js";
import type { RunnerApi } from "./api.js";
const cell = runnerMatrix.find(e => e.id === "extended-harnesses.runner-acpx-pi.daytona.hello-complete")!;
const sdkVersion: string = JSON.parse(readFileSync(new URL("../../packages/plugins/sdk/package.json", import.meta.url), "utf8")).version;
const roots: string[] = [];
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2e-installed-plugin-"))); roots.push(root);
  async function pkg(name: string, version: string, dependencies: Record<string,string> = {}, extra = {}) {
    const dir = join(root, "node_modules", name); const entry = name === "@daytonaio/sdk" ? "./esm/index.js" : "./dist/index.js"; await mkdir(join(dir, name === "@daytonaio/sdk" ? "esm" : "dist"), { recursive: true });
    const content = JSON.stringify({ name, version, type: "module", exports: { ".": { import: name === "@daytonaio/sdk" ? { types: "./esm/index.d.ts", default: entry } : entry } }, dependencies, ...extra });
    await writeFile(join(dir, "package.json"), content); await writeFile(join(dir, entry), "// compiled");
    return { root: dir, packageSha256: hash(content), entry, entrySha256: hash("// compiled") };
  }
  const plugin = await pkg("@paperclipai/plugin-daytona", "0.1.1", { "@paperclipai/plugin-sdk": sdkVersion, "@daytonaio/sdk": "0.203.0" }, { paperclipPlugin: { manifest: "./dist/manifest.js", worker: "./dist/worker.js" } });
  await writeFile(join(plugin.root, "dist/manifest.js"), "// manifest"); await writeFile(join(plugin.root, "dist/worker.js"), "// worker");
  const authority: InstalledDaytonaPluginAuthority = { schema: "paperclip.e2e.installed-daytona-plugin/v1", graphRoot: root, plugin: { ...plugin, manifestSha256: hash("// manifest"), workerSha256: hash("// worker") }, sdk: await pkg("@paperclipai/plugin-sdk", sdkVersion, { "@paperclipai/shared": "0.3.1" }), shared: await pkg("@paperclipai/shared", "0.3.1"), daytona: await pkg("@daytonaio/sdk", "0.203.0") };
  const authorityPath = join(root, "authority.json");
  const env: NodeJS.ProcessEnv = { PAPERCLIP_RUNNER_E2E_INSTALLED_CLI: "/reviewed/cli", PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256: "reviewed-separately", PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT: "/reviewed/server", PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256: "reviewed-separately", PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN: plugin.root, PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY: authorityPath };
  async function seal() { const bytes = JSON.stringify(authority); await writeFile(authorityPath, bytes); env.PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY_SHA256 = hash(bytes); }
  await seal(); return { root, authority, env, seal };
}
it("admits pinned published plugin and resolved SDK graph without claiming a full graph audit", async () => {
  const f = await fixture(); expect(await verifyInstalledDaytonaPlugin(f.env, [cell])).toMatchObject({ packageRoot: f.authority.plugin.root, sourceFallback: false, fullGraphVerified: false, completeGraphAuthorityRequired: true });
});
it("fails closed for absent/partial installed Daytona pins but preserves ordinary source and local lanes", async () => {
  const f = await fixture();
  for (const key of installedDaytonaPluginKeys) await expect(verifyInstalledDaytonaPlugin({ ...f.env, [key]: undefined }, [cell])).rejects.toThrow("complete pins");
  await expect(verifyInstalledDaytonaPlugin({}, [cell])).resolves.toBeUndefined();
  const local = runnerMatrix.find(e => e.id === "extended-harnesses.runner-acpx-pi.local.hello-complete")!;
  await expect(verifyInstalledDaytonaPlugin(f.env, [local])).rejects.toThrow("Daytona selection");
  const noPlugin = { ...f.env }; for (const key of installedDaytonaPluginKeys) delete noPlugin[key];
  await expect(verifyInstalledDaytonaPlugin(noPlugin, [local])).resolves.toBeUndefined();
  await expect(verifyInstalledDaytonaPlugin(noPlugin, [cell])).rejects.toThrow("complete pins");
});
it("rejects stale authority, worker, manifest and dependency entry bytes", async () => {
  const f = await fixture();
  await expect(verifyInstalledDaytonaPlugin({ ...f.env, PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY_SHA256: "0".repeat(64) }, [cell])).rejects.toThrow("reviewed pins");
  for (const [path, original] of [[join(f.authority.plugin.root,"dist/worker.js"),"// worker"], [join(f.authority.plugin.root,"dist/manifest.js"),"// manifest"], [join(f.authority.sdk.root,"dist/index.js"),"// compiled"]]) {
    await writeFile(path!, "// wrong"); await expect(verifyInstalledDaytonaPlugin(f.env,[cell])).rejects.toThrow("reviewed pins"); await writeFile(path!,original!);
  }
});
it("rejects source exports and workspace dependency versions even with refreshed pins", async () => {
  const f = await fixture(); const p = join(f.authority.plugin.root,"package.json");
  const original = { name:"@paperclipai/plugin-daytona",version:"0.1.1",exports:{".":{import:"./dist/index.js"}},paperclipPlugin:{manifest:"./dist/manifest.js",worker:"./dist/worker.js"},dependencies:{"@paperclipai/plugin-sdk":sdkVersion,"@daytonaio/sdk":"0.203.0"} };
  for (const manifest of [{ ...original, exports:{".":{import:"./src/index.ts"}} }, { ...original, dependencies:{ ...original.dependencies,"@paperclipai/plugin-sdk":"workspace:*" } }]) {
    const bytes=JSON.stringify(manifest);await writeFile(p,bytes);f.authority.plugin.packageSha256=hash(bytes);await f.seal();await expect(verifyInstalledDaytonaPlugin(f.env,[cell])).rejects.toThrow(/compiled package exports|dependency identity/);
  }
});
it("rejects linked or escaped roots and a shadowed foreign resolved dependency", async () => {
  const f = await fixture(); const other = await fixture();
  f.authority.shared=other.authority.shared;await f.seal();await expect(verifyInstalledDaytonaPlugin(f.env,[cell])).rejects.toThrow("escapes");
  f.authority.shared={...other.authority.shared,root:join(f.root,"node_modules/@paperclipai/shared")};await f.seal();
  const nested=join(f.authority.plugin.root,"node_modules/@paperclipai");await mkdir(nested,{recursive:true});await symlink(other.authority.sdk.root,join(nested,"plugin-sdk"));
  await expect(verifyInstalledDaytonaPlugin(f.env,[cell])).rejects.toThrow("foreign dependency");
  await rm(nested,{recursive:true});await rm(f.authority.shared.root,{recursive:true});await symlink(other.authority.shared.root,f.authority.shared.root);
  await expect(verifyInstalledDaytonaPlugin(f.env,[cell])).rejects.toThrow("canonical and unlinked");
});
it.skipIf(process.platform === "win32")("rejects a FIFO authority without waiting for a writer", async () => {
  const f=await fixture();const p=f.env.PAPERCLIP_RUNNER_E2E_INSTALLED_DAYTONA_PLUGIN_AUTHORITY!;await rm(p);execFileSync("/usr/bin/mkfifo",[p],{timeout:5000,env:{}});await expect(verifyInstalledDaytonaPlugin(f.env,[cell])).rejects.toThrow("bounded unlinked regular file");
});
it("uses the verified public package in the existing API and rejects changed bytes before any mutation", async () => {
  // This positive fixture models the sanitized installed launcher, not pnpm's parent environment.
  vi.stubEnv("NODE_OPTIONS", undefined); vi.stubEnv("NODE_PATH", undefined);
  const f=await fixture(); for(const [k,v]of Object.entries(f.env))vi.stubEnv(k,v!);
  const calls:unknown[]=[];
  const api={async post(url:string,data:unknown){calls.push({url,data});throw new Error("stop-after-public-install");}} as unknown as RunnerApi;
  const input={api,execution:cell,executionNonce:"nonce",workspacePath:"/tmp/workspace",credentials:{},daytonaImage:"ghcr.io/example/image@sha256:"+"a".repeat(64)};
  await expect(setupLiveFixtures(input)).rejects.toThrow("stop-after-public-install");
  expect(calls).toEqual([{url:"/api/plugins/install",data:{packageName:f.authority.plugin.root,isLocalPath:true}}]);
  calls.length=0;await writeFile(join(f.authority.plugin.root,"dist/worker.js"),"// changed");await expect(setupLiveFixtures(input)).rejects.toThrow("reviewed pins");expect(calls).toEqual([]);
});
it.each(["NODE_OPTIONS", "NODE_PATH"])("rejects ambient %s before the plugin install API", async (key) => {
  const f = await fixture();
  for (const [name, value] of Object.entries(f.env)) vi.stubEnv(name, value!);
  vi.stubEnv("NODE_OPTIONS", undefined); vi.stubEnv("NODE_PATH", undefined);
  const post = vi.fn();
  const api = { post } as unknown as RunnerApi;
  for (const value of ["", "foreign"]) {
    vi.stubEnv(key, value);
    await expect(setupLiveFixtures({ api, execution: cell, executionNonce: "nonce", workspacePath: "/tmp/workspace", credentials: {} })).rejects.toThrow("ambient Node injection");
    expect(post).not.toHaveBeenCalled();
  }
});
it("keeps fixture authority out of the production server environment", async()=>{const f=await fixture();const env=buildPaperclipServerEnvironment(f.env);for(const k of installedDaytonaPluginKeys)expect(env[k]).toBeUndefined();});
