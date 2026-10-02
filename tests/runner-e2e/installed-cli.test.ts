import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { assertInstalledCliSelection, installedCliKeys, verifyInstalledCli } from "./installed-cli.js";
import { buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment } from "./harness-env.js";
const cells = runnerMatrix.filter(e => e.profile.id === "runner-acpx-pi");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "e2e-installed-cli-"))); roots.push(root);
  const cli = join(root, "node_modules/paperclipai"); const server = join(root, "node_modules/@paperclipai/server");
  await mkdir(join(cli, "dist"), { recursive: true }); await mkdir(join(server, "dist"), { recursive: true });
  await writeFile(join(cli, "package.json"), JSON.stringify({ name: "paperclipai", version: "1.2.3", type: "module", bin: { paperclipai: "./dist/index.js" } }));
  await writeFile(join(server, "package.json"), JSON.stringify({ name: "@paperclipai/server", version: "1.2.3", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  await writeFile(join(cli, "dist/index.js"), "// installed public CLI"); await writeFile(join(server, "dist/index.js"), "// installed public server");
  const env = { PAPERCLIP_RUNNER_E2E_INSTALLED_CLI: join(cli, "dist/index.js"), PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256: hash("// installed public CLI"), PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT: server, PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_SHA256: hash("// installed public server") };
  return { root, cli, server, env };
}
it("admits all26 current Pi cases through pinned installed public CLI/server with no overrides", async () => {
  const { env, server } = await fixture(); expect(cells).toHaveLength(26);
  for (const cell of cells) expect(await verifyInstalledCli(env, [cell])).toMatchObject({ serverRoot: server, defaultRuntimeResolution: true, qualificationOverride: false });
});
it("qualified Pi always drops ambient candidate admission while pending C/C retain exact gates", () => {
  for (const cell of cells) expect(buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
  for (const agent of ["cursor", "copilot"]) {
    const cell = runnerMatrix.find(e => e.profile.qualificationCandidate === agent)!;
    expect(JSON.parse(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent, model: cell.profile.model }]);
  }
  const changed = { ...cells[0]!, profile: { ...cells[0]!.profile, model: "wrong-model" } };
  expect(() => buildRunnerE2EProcessEnvironment({}, [changed])).toThrow("exact declared model");
});
it("rejects partial authority, unsupported cells and every runtime/path override", async () => {
  const { env } = await fixture();
  for (const key of installedCliKeys) { const changed = { ...env, [key]: undefined }; await expect(verifyInstalledCli(changed, [cells[0]!])).rejects.toThrow("complete pins"); }
  expect(() => assertInstalledCliSelection(env, [])).toThrow("explicit supported Pi");
  expect(() => assertInstalledCliSelection(env, [runnerMatrix.find(e => e.profile.qualificationCandidate === "cursor")!])).toThrow("explicit supported Pi");
  for (const key of ["PAPERCLIP_RUNNER_BINARY", "PAPERCLIP_RUNNER_REMOTE_BINARY_PATH", "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH", "PAPERCLIP_RUNNER_ACPX_QUALIFICATION", "PAPERCLIP_ACPX_BUILTIN_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_ROOT", "PAPERCLIP_ACPX_PROVIDER_PACKAGE_MANIFEST", "NODE_OPTIONS", "NODE_PATH"]) await expect(verifyInstalledCli({ ...env, [key]: "foreign" }, [cells[0]!])).rejects.toThrow("forbids");
});
it("rejects stale bytes and another server root instead of falling back to source", async () => {
  const f = await fixture(); const other = await fixture();
  await expect(verifyInstalledCli({ ...f.env, PAPERCLIP_RUNNER_E2E_INSTALLED_SERVER_ROOT: other.server }, [cells[0]!])).rejects.toThrow("foreign server");
  await expect(verifyInstalledCli({ ...f.env, PAPERCLIP_RUNNER_E2E_INSTALLED_CLI_SHA256: "0".repeat(64) }, [cells[0]!])).rejects.toThrow("reviewed pins");
  await writeFile(join(f.server, "dist/index.js"), "changed");
  await expect(verifyInstalledCli(f.env, [cells[0]!])).rejects.toThrow("reviewed pins");
});
it("rejects linked entrypoints and source-export package identities", async () => {
  const f = await fixture(); const other = await fixture();
  await rm(join(f.cli, "dist/index.js")); await symlink(join(other.cli, "dist/index.js"), join(f.cli, "dist/index.js"));
  await expect(verifyInstalledCli(f.env, [cells[0]!])).rejects.toThrow("canonical and unlinked");
  await rm(join(f.cli, "dist/index.js")); await writeFile(join(f.cli, "dist/index.js"), "// installed public CLI");
  await writeFile(join(f.server, "package.json"), JSON.stringify({ name: "@paperclipai/server", version: "1.2.3", exports: { ".": "./src/index.ts" } }));
  await expect(verifyInstalledCli(f.env, [cells[0]!])).rejects.toThrow("public package identity");
});
it("keeps installed proof inputs out of the production server environment", async () => {
  const { env } = await fixture(); const server = buildPaperclipServerEnvironment(env);
  for (const key of installedCliKeys) expect(server[key]).toBeUndefined();
  await expect(verifyInstalledCli({}, [])).resolves.toBeUndefined();
});

it.skipIf(process.platform === "win32")("rejects a FIFO entrypoint without waiting for a writer", async () => {
  const f = await fixture(); await rm(f.env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI);
  execFileSync("/usr/bin/mkfifo", [f.env.PAPERCLIP_RUNNER_E2E_INSTALLED_CLI], { timeout: 5000, env: {} });
  await expect(verifyInstalledCli(f.env, [cells[0]!])).rejects.toThrow("bounded regular file");
});

it("uses the direct public Playwright JS bin without bin-shim Node injection", async () => {
  const { runnerE2EPlaywrightInvocation } = await import("./web-server-command.js");
  const f = await fixture(); const cli = join(f.root,"node_modules/@playwright/test/cli.js");
  await mkdir(join(f.root,"node_modules/@playwright/test"),{recursive:true});
  await writeFile(cli,"console.log(JSON.stringify({nodePath:process.env.NODE_PATH??null,nodeOptions:process.env.NODE_OPTIONS??null,args:process.argv.slice(2)}))");
  const invocation = runnerE2EPlaywrightInvocation(f.root,["--version"],true);
  expect(invocation.command).toBe(process.execPath);
  expect(JSON.parse(execFileSync(invocation.command,invocation.args,{env:{},timeout:5000,encoding:"utf8"}))).toEqual({nodePath:null,nodeOptions:null,args:["--version"]});
  expect(runnerE2EPlaywrightInvocation(f.root,["--version"],false)).toEqual({command:"pnpm",args:["exec","playwright","--version"]});
  for (const key of ["NODE_PATH","NODE_OPTIONS"]) expect(()=>assertInstalledCliSelection({...f.env,[key]:""},[cells[0]!])).toThrow("ambient Node injection");
});

it("startup-only accepts only explicit uncredentialed local hello and zero retries", async () => {
  const { assertInstalledStartupOnly } = await import("./installed-cli.js");
  const { parseRunnerSelectors } = await import("./selectors.js");
  const f=await fixture(); const cell=cells.find(e=>e.id==="extended-harnesses.runner-acpx-pi.local.hello-complete")!;
  const options=parseRunnerSelectors(["--installed-startup-only","--id",cell.id,"--max-automatic-retries","0"]);
  expect(options.installedStartupOnly).toBe(true);expect(()=>assertInstalledStartupOnly(f.env,[cell],options)).not.toThrow();
  for(const delta of [{maxAutomaticRetries:1},{maxParallel:2},{ui:true},{debug:true},{headed:true},{list:true},{matrixJson:true},{ids:[]}])expect(()=>assertInstalledStartupOnly(f.env,[cell],{...options,...delta})).toThrow("startup-only");
  expect(()=>assertInstalledStartupOnly(f.env,[cells.find(e=>e.environment.id==="daytona")!],options)).toThrow("startup-only");
  expect(()=>assertInstalledStartupOnly({...f.env,OPENROUTER_API_KEY:"dummy-not-a-real-key"},[cell],options)).toThrow("credential inputs");
  expect(()=>assertInstalledStartupOnly({...f.env,KIMI_MODEL_API_KEY:"dummy-not-a-real-key"},[cell],options)).toThrow("credential inputs");
  expect(()=>assertInstalledStartupOnly({},[cell],options)).toThrow("startup-only");
});
