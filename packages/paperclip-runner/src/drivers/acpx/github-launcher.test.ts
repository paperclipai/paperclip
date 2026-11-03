import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { githubLauncherSource } from "../../../../adapter-utils/src/github-launcher.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxRecoveryBinding } from "./recovery-identity.js";
import { prepareAcpxRuntimeSandbox } from "./runtime-sandbox.js";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it.skipIf(process.platform === "win32").each(["isolated", "prepared", "preconfigured"])("authenticates Claude shell commands through its session broker (%s home)", async homeMode => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-acpx-github-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const runtimeDirectory = join(root, "runtime");
  const managed = join(root, "managed");
  const real = join(root, "real");
  const home = join(root, "home");
  await Promise.all([workspace, runtimeDirectory, managed, real, home].map(path => mkdir(path)));
  await mkdir(join(home, ".claude"));
  const binding = await createAcpxRecoveryBinding({
    runtimeDirectory,
    normalizedSessionId: "github-session",
    workingDirectory: workspace,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"),
    requestedModel: "claude-sonnet-5",
    permissionMode: "approve-reads",
  });
  let identity: "first" | "second" | null = "first";
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    requests++;
    if (req.method !== "POST" || req.url !== "/runtime-tools/github/credentials"
      || req.headers.authorization !== "Bearer fixture-bridge"
      || req.headers["x-paperclip-github-capability"] !== "fixture-session") {
      res.writeHead(403).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(identity
      ? { status: "available", env: { GH_TOKEN: `fixture-operation-${identity}` } }
      : { status: "unavailable", reason: "Fixture connection revoked" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = [managed, real, dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  await writeFile(join(managed, ".bashrc"), `export PATH='${path}'\n`);
  const executable = `#!/usr/bin/env node
const token = process.env.GH_TOKEN;
const identity = token === 'fixture-operation-first' ? 'first' : token === 'fixture-operation-second' ? 'second' : 'anonymous';
console.log(identity);
`;
  for (const program of ["git", "gh"]) {
    await writeFile(join(managed, program), githubLauncherSource(), { mode: 0o700 });
    await writeFile(join(real, program), executable, { mode: 0o700 });
  }
  const environment = {
    PATH: path,
    BASH_ENV: join(managed, ".bashrc"),
    ZDOTDIR: managed,
    GH_CONFIG_DIR: managed,
    PAPERCLIP_GITHUB_LAUNCHER_DIR: managed,
    PAPERCLIP_GITHUB_BROKER_URL: url,
    PAPERCLIP_GITHUB_BROKER_TOKEN: "fixture-session",
    PAPERCLIP_GITHUB_BRIDGE_TOKEN: "fixture-bridge",
    GH_TOKEN: "ambient-must-not-leak",
    GITHUB_TOKEN: "ambient-must-not-leak",
    ...(homeMode === "preconfigured" ? { HOME: home, PAPERCLIP_RUNNER_HOME_MODE: "preconfigured" } : {}),
    ...(homeMode === "prepared" ? { PAPERCLIP_RUNNER_PREPARED_HARNESS_HOME: join(home, ".claude") } : {}),
  };
  const sandbox = await prepareAcpxRuntimeSandbox({ binding, agent: "claude", environment });
  const commands = "git ls-remote https://github.com/example/fixture; gh api user";
  for (const currentIdentity of ["first", "second", null] as const) {
    identity = currentIdentity;
    const result = await execute("/bin/bash", ["-c", commands], { cwd: workspace, env: sandbox.launchEnvironment, timeout: 10_000 });
    expect(result.stdout.trim().split("\n")).toEqual([identity ?? "anonymous", identity ?? "anonymous"]);
    if (identity) expect(result.stderr).toBe("");
    else expect(result.stderr).toContain("Fixture connection revoked");
  }
  expect(requests).toBe(6);
  expect(sandbox.launchEnvironment.GH_TOKEN).toBeUndefined();
  expect(sandbox.launchEnvironment.GITHUB_TOKEN).toBeUndefined();
  expect(JSON.stringify(sandbox.persistedEnvironment)).not.toMatch(/fixture-(?:session|bridge|operation)|PAPERCLIP_GITHUB_BROKER|PAPERCLIP_GITHUB_BRIDGE/);
  const recovered = await prepareAcpxRuntimeSandbox({ binding, agent: "claude", environment });
  identity = "first";
  expect((await execute("/bin/bash", ["-c", commands], { cwd: workspace, env: recovered.launchEnvironment, timeout: 10_000 })).stdout.trim().split("\n")).toEqual(["first", "first"]);
  expect(requests).toBe(8);
  expect(await readFile(join(managed, "gh"), "utf8")).not.toContain("fixture-session");
});
