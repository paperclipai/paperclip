import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const githubUrl = "https://github.com/paperclipai/paperclip.git";
const azureUrl = "https://dev.azure.com/contoso/Platform/_git/paperclip";
const hostGithubCredential = "host-github-credential-canary";
const azureCredential = "azure-run-credential-canary";
const brokerCapability = "run-bound-capability-canary";
const azureHelper = `!f() { proto=; host=; path=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in protocol=*) proto=\${l#protocol=};; host=*) host=\${l#host=};; path=*) path=\${l#path=};; esac; done; if [ "$1" = get ] && [ "$proto" = https ] && [ "$host" = dev.azure.com ] && [ "$path" = "$PAPERCLIP_AZURE_GIT_PATH" ]; then printf 'username=paperclip\\npassword=%s\\n' "$PAPERCLIP_AZURE_GIT_TOKEN"; fi; }; f`;

const fakeGit = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('remote') && args.includes('get-url')) {
  process.stdout.write(process.env.PAPERCLIP_TEST_REMOTE_URL || '');
  process.exit(0);
}
if (args.includes('clone') || args.includes('push')) {
  const url = process.env.PAPERCLIP_TEST_REPOSITORY_URL || '';
  const filled = spawnSync(process.env.PAPERCLIP_TEST_REAL_GIT, ['credential', 'fill'], {
    input: 'url=' + url + '\\n\\n', encoding: 'utf8', timeout: 5000,
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
  const values = Object.fromEntries(String(filled.stdout || '').trim().split('\\n').filter(Boolean).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  fs.writeFileSync(process.env.PAPERCLIP_TEST_CAPTURE, JSON.stringify({
    args, fillStatus: filled.status, username: values.username || null, password: values.password || null,
    ghToken: process.env.GH_TOKEN || null, githubToken: process.env.GITHUB_TOKEN || null,
    azureToken: process.env.PAPERCLIP_AZURE_GIT_TOKEN || null,
    hostAuthMode: process.env.PAPERCLIP_GITHUB_AUTH_MODE || null,
  }));
  process.stdout.write('fake git operation completed\\n');
}
`;

async function fixture(options: { hostGitHub?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-azure-host-git-launcher-"));
  roots.push(root);
  const managed = path.join(root, "managed"), realBin = path.join(root, "real"), hostHome = path.join(root, "host-home");
  await Promise.all([mkdir(managed), mkdir(realBin), mkdir(hostHome)]);
  const hostHelper = path.join(root, "host-credential-helper");
  await writeFile(hostHelper, `#!/bin/sh\nprintf 'username=host-user\\npassword=${hostGithubCredential}\\n'\n`, { mode: 0o700 });
  await writeFile(path.join(hostHome, ".gitconfig"), `[credential]\n\thelper = !${hostHelper}\n`);
  const launcher = path.join(managed, "git");
  await writeFile(launcher, githubLauncherSource(options as Parameters<typeof githubLauncherSource>[0]), { mode: 0o700 });
  await writeFile(path.join(realBin, "git"), fakeGit, { mode: 0o700 });
  const capture = path.join(root, "capture.json");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  let status = 200;
  let responseBody: unknown = azureBody();
  const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
  const server = createServer((req, res) => { void captureRequest(req, res); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  async function captureRequest(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = null; }
    requests.push({ path: req.url ?? "", headers: req.headers, body });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(responseBody));
  }
  function setResponse(nextStatus: number, body: unknown) { status = nextStatus; responseBody = body; }
  function env(overrides: Record<string, string> = {}) {
    const brokerEnv = githubBrokerEnvironment({ PATH: `${managed}${path.delimiter}${realBin}${path.delimiter}${process.env.PATH}` },
      { url: `http://127.0.0.1:${port}`, token: brokerCapability }, { preserveHostGitHub: options.hostGitHub === true });
    return {
      ...process.env,
      ...brokerEnv,
      PATH: `${managed}${path.delimiter}${realBin}${path.delimiter}${process.env.PATH}`,
      HOME: hostHome,
      GIT_CONFIG_GLOBAL: path.join(hostHome, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      PAPERCLIP_TEST_REAL_GIT: realGit,
      PAPERCLIP_TEST_CAPTURE: capture,
      PAPERCLIP_TEST_REPOSITORY_URL: azureUrl,
      PAPERCLIP_TEST_REMOTE_URL: "",
      ...(options.hostGitHub ? { PAPERCLIP_GITHUB_AUTH_MODE: "managed" } : {}),
      ...overrides,
    };
  }
  return { root, launcher, capture, requests, setResponse, env };
}

function azureBody() {
  return { status: "available", env: {
    PAPERCLIP_AZURE_GIT_TOKEN: azureCredential,
    PAPERCLIP_AZURE_GIT_PATH: "contoso/Platform/_git/paperclip",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.useHttpPath", GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "credential.interactive", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.askPass", GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: "http.followRedirects", GIT_CONFIG_VALUE_4: "false",
    GIT_CONFIG_KEY_5: "credential.https://dev.azure.com.helper", GIT_CONFIG_VALUE_5: azureHelper,
  } };
}

it("uses host GitHub credentials without calling the broker when host mode is baked into the launcher", async () => {
  const f = await fixture({ hostGitHub: true });
  const result = await exec(process.execPath, [f.launcher, "clone", githubUrl], {
    cwd: f.root, env: f.env({ PAPERCLIP_TEST_REPOSITORY_URL: githubUrl }),
  });
  const capture = JSON.parse(await readFile(f.capture, "utf8"));
  expect(result.stdout).toContain("fake git operation completed");
  expect(capture).toMatchObject({ args: ["clone", githubUrl], fillStatus: 0, username: "host-user", password: hostGithubCredential });
  expect(f.requests).toEqual([]);
});

it("brokers Azure clone and push-origin while excluding host credentials", async () => {
  const f = await fixture({ hostGitHub: true });
  const env = f.env({ PAPERCLIP_TEST_REMOTE_URL: azureUrl });
  const clone = await exec(process.execPath, [f.launcher, "clone", azureUrl], { cwd: f.root, env });
  expect(clone.stdout).toContain("fake git operation completed");
  const cloneCapture = JSON.parse(await readFile(f.capture, "utf8"));
  expect(cloneCapture).toMatchObject({ args: ["clone", azureUrl], fillStatus: 0, username: "paperclip",
    password: azureCredential, azureToken: azureCredential });
  expect(cloneCapture.password).not.toBe(hostGithubCredential);

  const push = await exec(process.execPath, [f.launcher, "-C", f.root, "push", "origin"], { cwd: f.root, env });
  expect(push.stdout).toContain("fake git operation completed");
  const pushCapture = JSON.parse(await readFile(f.capture, "utf8"));
  expect(pushCapture).toMatchObject({ args: ["-C", f.root, "push", "origin"], fillStatus: 0, username: "paperclip",
    password: azureCredential, azureToken: azureCredential });
  expect(pushCapture.password).not.toBe(hostGithubCredential);

  expect(f.requests.map(item => item.path)).toEqual(["/runtime-tools/git/credentials", "/runtime-tools/git/credentials"]);
  for (const item of f.requests) {
    expect(item.body).toEqual({ repositoryUrl: azureUrl });
    expect(item.headers.authorization).toBe(`Bearer ${brokerCapability}`);
    expect(JSON.stringify(item)).not.toContain(hostGithubCredential);
  }
});

it("stops a denied Azure operation without falling back to the host credential store", async () => {
  const f = await fixture({ hostGitHub: true });
  f.setResponse(403, { error: `provider denied ${hostGithubCredential}` });
  const result = await exec(process.execPath, [f.launcher, "clone", azureUrl], {
    cwd: f.root, env: f.env({ PAPERCLIP_TEST_REMOTE_URL: azureUrl }),
  }).catch(error => error as Error & { code?: number; stderr?: string });
  expect(result).toMatchObject({ code: 1 });
  expect(result.stderr).toContain("Azure DevOps repository authorization unavailable");
  expect(result.stderr).not.toContain(hostGithubCredential);
  expect(f.requests).toHaveLength(1);
  await expect(readFile(f.capture, "utf8")).rejects.toThrow();
});

it.each([
  ["credential-bearing HTTPS clone", ["clone", "https://host-user:secret@dev.azure.com/contoso/Platform/_git/paperclip"], "https://host-user:secret@dev.azure.com/contoso/Platform/_git/paperclip"],
  ["trailing-dot Azure host", ["clone", "https://dev.azure.com./contoso/Platform/_git/paperclip"], "https://dev.azure.com./contoso/Platform/_git/paperclip"],
  ["SSH Azure clone", ["clone", "ssh://git@ssh.dev.azure.com/v3/contoso/Platform/paperclip"], "ssh://git@ssh.dev.azure.com/v3/contoso/Platform/paperclip"],
  ["Azure archive remote", ["archive", "--remote=ssh://git@ssh.dev.azure.com/v3/contoso/Platform/paperclip", "HEAD"], "ssh://git@ssh.dev.azure.com/v3/contoso/Platform/paperclip"],
] as const)("routes %s through Azure authorization and refuses host fallback", async (_name, args, remoteUrl) => {
  const f = await fixture({ hostGitHub: true });
  f.setResponse(403, { error: `provider denied ${hostGithubCredential}` });
  const result = await exec(process.execPath, [f.launcher, ...args], {
    cwd: f.root, env: f.env({ PAPERCLIP_TEST_REPOSITORY_URL: remoteUrl, PAPERCLIP_TEST_REMOTE_URL: remoteUrl }),
  }).catch(error => error as Error & { code?: number; stderr?: string });
  expect(result).toMatchObject({ code: 1 });
  expect(result.stderr).toContain("Azure DevOps repository authorization unavailable");
  expect(result.stderr).not.toContain(hostGithubCredential);
  expect(f.requests.map(item => item.path)).toEqual(["/runtime-tools/git/credentials"]);
  expect(f.requests[0]?.body).toEqual({ repositoryUrl: remoteUrl });
  expect(f.requests[0]?.headers.authorization).toBe(`Bearer ${brokerCapability}`);
  await expect(readFile(f.capture, "utf8")).rejects.toThrow();
});

it("does not enable host GitHub mode from an environment variable alone", async () => {
  const f = await fixture();
  const managedGithubCredential = "broker-managed-github-token";
  f.setResponse(200, { status: "available", env: { GH_TOKEN: managedGithubCredential } });
  const result = await exec(process.execPath, [f.launcher, "clone", githubUrl], {
    cwd: f.root, env: f.env({ PAPERCLIP_GITHUB_AUTH_MODE: "host", PAPERCLIP_TEST_REPOSITORY_URL: githubUrl }),
  });
  const capture = JSON.parse(await readFile(f.capture, "utf8"));
  expect(result.stdout).toContain("fake git operation completed");
  expect(capture).toMatchObject({ args: ["clone", githubUrl], ghToken: managedGithubCredential, hostAuthMode: "host" });
  expect(capture.password).not.toBe(hostGithubCredential);
  expect(f.requests.map(item => item.path)).toEqual(["/runtime-tools/github/credentials"]);
  expect(f.requests[0]?.body).toEqual({});
});

it.each([
  ["remote", "update"],
  ["fetch", "--all"],
  ["fetch", "--multiple", "origin", "other"],
  ["submodule", "update", "--init"],
])("rejects multi-remote operation %j in baked-in host mode", async (...args) => {
  const f = await fixture({ hostGitHub: true });
  const result = await exec(process.execPath, [f.launcher, ...args], {
    cwd: f.root, env: f.env({ PAPERCLIP_TEST_REMOTE_URL: azureUrl }),
  }).catch(error => error as Error & { code?: number; stderr?: string });
  expect(result).toMatchObject({ code: 1 });
  expect(result.stderr).toContain("select one repository for this Git operation");
  expect(f.requests).toEqual([]);
  await expect(readFile(f.capture, "utf8")).rejects.toThrow();
});
