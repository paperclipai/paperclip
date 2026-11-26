import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runnerMatrix } from "./catalog.js";
import { assertInstalledCliSelection, installedCliKeys, probeInstalledCodexStartup, verifyInstalledCli } from "./installed-cli.js";
import { buildPaperclipServerEnvironment, buildRunnerE2EProcessEnvironment } from "./harness-env.js";
const cells = runnerMatrix.filter(e => e.profile.id === "runner-acpx-pi");
const roots: string[] = [];
beforeEach(() => {
  vi.stubEnv("NODE_PATH", undefined);
  vi.stubEnv("NODE_OPTIONS", undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
it("admits existing Codex onboarding, useful-file revision and restart journeys without broadening other cells", async () => {
  const { env, server } = await fixture();
  for (const id of ["first-task.runner-codex.local.task-card-accept", "everyday-workflows.runner-codex.local.build-revise", "agent-chat.runner-codex.local.continuity-restart"]) {
    const cell = runnerMatrix.find(e => e.id === id)!;
    expect(cell).toBeDefined();
    expect(await verifyInstalledCli(env, [cell])).toMatchObject({ serverRoot: server, defaultRuntimeResolution: true, qualificationOverride: false });
    for (const key of ["PAPERCLIP_RUNNER_BINARY", "NODE_PATH"]) expect(() => assertInstalledCliSelection({ ...env, [key]: "foreign" }, [cell])).toThrow("forbids");
  }
  for (const id of ["first-task.legacy-codex.local.task-card-accept", "first-task.runner-codex.local.interview-first-response", "everyday-workflows.runner-codex.daytona.build-revise"]) {
    const cell = runnerMatrix.find(e => e.id === id)!;
    expect(cell).toBeDefined();
    expect(() => assertInstalledCliSelection(env, [cell])).toThrow("explicit supported Pi or Codex");
  }
});
it("qualified providers drop ambient admission while pending Copilot retains its exact gate", () => {
  for (const cell of cells) expect(buildRunnerE2EProcessEnvironment({ PAPERCLIP_RUNNER_ACPX_QUALIFICATION: "ambient" }, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
  for (const agent of ["copilot"]) {
    const cell = runnerMatrix.find(e => e.profile.qualificationCandidate === agent)!;
    expect(JSON.parse(buildRunnerE2EProcessEnvironment({}, [cell]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION!)).toEqual([{ agent, model: cell.profile.model }]);
  }
  const changed = { ...cells[0]!, profile: { ...cells[0]!.profile, model: "custom/explicit-model" } };
  expect(buildRunnerE2EProcessEnvironment({}, [changed]).PAPERCLIP_RUNNER_ACPX_QUALIFICATION).toBeUndefined();
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

async function startupFixture(mode: "normal" | "wrong-model" | "ambient-codex" | "startup-and-cleanup-failed" | "cleanup-failed" = "normal") {
  const f = await fixture();
  const vendor = join(f.server, "dist/vendor/paperclip-runner");
  const daemon = join(vendor, "bin", `${process.platform}-${process.arch}`, "paperclip-runnerd");
  const codex = join(f.root, "node_modules/@openai/codex/bin/codex");
  const observations = join(f.root, "startup-observations.json");
  await mkdir(join(vendor, "bin", `${process.platform}-${process.arch}`), { recursive: true });
  await mkdir(join(f.server, "dist/services/native-runtime"), { recursive: true });
  await mkdir(join(f.root, "node_modules/@openai/codex/bin"), { recursive: true });
  await writeFile(daemon, "fixture-daemon");
  await writeFile(codex, "#!/bin/sh\nprintf 'codex-cli 0.149.5\\n'\n");
  await chmod(codex, 0o755);
  await writeFile(join(f.server, "dist/services/native-runtime/native-codex-runner.js"), `export function resolvePaperclipRunnerBinary() { return ${JSON.stringify(daemon)}; }`);
  await writeFile(join(vendor, "index.js"), `
    import {writeFileSync} from "node:fs";
    const state={calls:[],environmentKeys:[],fileAuthPinned:false};let retired=false;
    const save=()=>writeFileSync(${JSON.stringify(observations)},JSON.stringify(state));
    export function resolveCodexCommand(){return ${JSON.stringify(mode === "ambient-codex" ? process.execPath : codex)};}
    export function createIsolatedCodexAppServerArgs(){return ["app-server"];}
    export function createRunnerdCodexTransport(options){
      state.environmentKeys=Object.keys(options.environment).sort();
      state.fileAuthPinned=options.codexArgs.includes('cli_auth_credentials_store="file"');
      state.privateStateDirectory=options.stateDirectory;
      save();return {transport:{async close(){retired=true;state.calls.push("transport-close");save();${mode === "startup-and-cleanup-failed" ? 'throw new Error("fixture secondary transport cleanup failure");' : ''}}},
        evidence:()=>({runnerPid:111,codexPid:222,providerDriver:"codex_app_server",runnerExited:retired,diagnostics:["fixture provider bootstrap failed"],providerSessionId:"PRIVATE-PROVIDER-ID"})};}
    export class CodexAppServerDriver {
      constructor(options){this.options=options;}
      async openSession(){state.calls.push("open");save();
        ${mode === "startup-and-cleanup-failed" ? 'throw new Error("fixture original provider startup failure");' : ''}
        const model=${JSON.stringify(mode === "wrong-model" ? "wrong-model" : "gpt-5.6-sol")};
        return {ids:()=>({driverSessionId:"PRIVATE-DRIVER-ID",providerSessionId:"PRIVATE-PROVIDER-ID"}),
          events:()=>({async *[Symbol.asyncIterator](){yield {eventType:"session.started",payload:{context:{model,sandbox:{permissionProfile:{id:"paperclip-runner-workspace-read-only"}}}}};}}),
          startTurn(){state.calls.push("FORBIDDEN-TURN");save();throw new Error("No provider turn is permitted");},
          async close(){retired=true;state.calls.push("session-close");save();${mode === "cleanup-failed" ? 'throw new Error("fixture session cleanup failure");' : ''}}};}
    }
  `);
  return { ...f, observations, expectedRunnerSha256: hash("fixture-daemon") };
}

it.skipIf(process.platform === "win32")("installed native startup uses closed homes, file-only auth and no turn or version equality gate", async () => {
  const f = await startupFixture();
  const receipt = await probeInstalledCodexStartup({ consumerRoot: f.root, serverRoot: f.server, expectedRunnerSha256: f.expectedRunnerSha256 });
  expect(receipt).toMatchObject({ nativeSessionStarted: true, cleanupConfirmed: true, providerTurns: 0, credentialsUsed: false,
    codexVersion: "codex-cli 0.149.5", defaultRuntimeResolution: true, reasoningEffortExercised: false });
  expect(await readFile(f.observations, "utf8").then(JSON.parse)).toMatchObject({ calls: ["open", "session-close"], fileAuthPinned: true,
    environmentKeys: ["CODEX_HOME", "HOME", "LC_ALL", "PAPERCLIP_RUNNER_NETWORK_ACCESS", "PATH", "TMPDIR", "TZ"] });
  expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE-(?:DRIVER|PROVIDER)-ID/);
});

it.skipIf(process.platform === "win32")("installed startup preserves the primary cause, records bounded diagnostics and attempts independent cleanup", async () => {
  const f = await startupFixture("startup-and-cleanup-failed");
  const error = await probeInstalledCodexStartup({ consumerRoot: f.root, serverRoot: f.server, expectedRunnerSha256: f.expectedRunnerSha256 }).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.message).toContain("fixture original provider startup failure");
  expect(error.message).toContain("fixture secondary transport cleanup failure");
  expect(error.message).toContain("fixture provider bootstrap failed");
  expect(error.cause.message).toBe("fixture original provider startup failure");
  expect(error.errors.map((error: Error) => error.message)).toEqual(["fixture original provider startup failure", "fixture secondary transport cleanup failure"]);
  expect(error.message).not.toContain("PRIVATE-PROVIDER-ID");
  const observations = JSON.parse(await readFile(f.observations, "utf8"));
  expect(observations.calls).toEqual(["open", "transport-close"]);
  await expect(lstat(observations.privateStateDirectory)).rejects.toThrow();
});

it.skipIf(process.platform === "win32")("installed startup cannot qualify when session cleanup fails after successful open", async () => {
  const f = await startupFixture("cleanup-failed");
  await expect(probeInstalledCodexStartup({ consumerRoot: f.root, serverRoot: f.server, expectedRunnerSha256: f.expectedRunnerSha256 })).rejects.toThrow("fixture session cleanup failure");
  expect(JSON.parse(await readFile(f.observations, "utf8")).calls).toEqual(["open", "session-close", "session-close"]);
});

it.skipIf(process.platform === "win32")("installed startup rejects stale daemon/ambient Codex and cleans a mismatched native session", async () => {
  const f = await startupFixture();
  await expect(probeInstalledCodexStartup({ consumerRoot: f.root, serverRoot: f.server, expectedRunnerSha256: "0".repeat(64) })).rejects.toThrow("reviewed pin");
  await expect(readFile(f.observations)).rejects.toThrow();
  const ambient = await startupFixture("ambient-codex");
  await expect(probeInstalledCodexStartup({ consumerRoot: ambient.root, serverRoot: ambient.server, expectedRunnerSha256: ambient.expectedRunnerSha256 })).rejects.toThrow("ambient Codex");
  const wrong = await startupFixture("wrong-model");
  await expect(probeInstalledCodexStartup({ consumerRoot: wrong.root, serverRoot: wrong.server, expectedRunnerSha256: wrong.expectedRunnerSha256 })).rejects.toThrow("matching native identity");
  expect(await readFile(wrong.observations, "utf8").then(JSON.parse)).toMatchObject({ calls: ["open", "session-close"] });
});

it("installed startup rejects ambient Node injection before launching", async () => {
  vi.stubEnv("NODE_PATH", "/untrusted/test-path");
  await expect(probeInstalledCodexStartup({ consumerRoot: "/unused", serverRoot: "/unused", expectedRunnerSha256: "0".repeat(64) })).rejects.toThrow("forbids NODE_PATH");
});
