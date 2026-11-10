import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await new Promise<void>((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const azureUrl = "https://dev.azure.com/contoso/Project/_git/repo";
const pat = "azure-pat-must-stay-in-env-only";
const capability = "run-capability-must-not-leak";
const helper = `!f() { proto=; host=; path=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in protocol=*) proto=\${l#protocol=};; host=*) host=\${l#host=};; path=*) path=\${l#path=};; esac; done; if [ "$1" = get ] && [ "$proto" = https ] && [ "$host" = dev.azure.com ] && [ "$path" = "$PAPERCLIP_AZURE_GIT_PATH" ]; then printf 'username=paperclip\\npassword=%s\\n' "$PAPERCLIP_AZURE_GIT_TOKEN"; fi; }; f`;

const fakeGit = `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('remote') && args.includes('get-url')) {
  process.stdout.write(process.env.PAPERCLIP_TEST_REMOTE_URL || '');
  process.exit(0);
}
if (args.includes('clone') || args.includes('push')) {
  const credentialEnv = { ...process.env, PATH: '/usr/bin:/bin' };
  const credentialInput = 'url=' + process.env.PAPERCLIP_TEST_REPOSITORY_URL + '\\n\\n';
  const fill = spawnSync(process.env.PAPERCLIP_TEST_REAL_GIT, ['credential', 'fill'], {
    input: credentialInput, encoding: 'utf8', env: credentialEnv,
  });
  const values = Object.fromEntries(String(fill.stdout || '').trim().split('\\n').filter(Boolean).map(line => {
    const split = line.indexOf('='); return [line.slice(0, split), line.slice(split + 1)];
  }));
  fs.writeFileSync(process.env.PAPERCLIP_TEST_CAPTURE, JSON.stringify({
    args, credentialExit: fill.status,
    username: values.username || null,
    tokenMatched: values.password === process.env.PAPERCLIP_TEST_EXPECTED_TOKEN,
    hostTokenMatched: values.password === process.env.PAPERCLIP_TEST_HOST_TOKEN,
    tokenInArgs: args.some(arg => arg.includes(process.env.PAPERCLIP_TEST_EXPECTED_TOKEN || 'never-match')),
    envHasAzureToken: process.env.PAPERCLIP_AZURE_GIT_TOKEN === process.env.PAPERCLIP_TEST_EXPECTED_TOKEN,
    envHasGitHubToken: process.env.GH_TOKEN === process.env.PAPERCLIP_TEST_EXPECTED_GITHUB_TOKEN,
  }));
  process.stdout.write('fake git operation completed\\n');
}
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-azure-git-launcher-"));
  roots.push(root);
  const managed = path.join(root, "managed"), realBin = path.join(root, "real");
  await mkdir(managed); await mkdir(realBin);
  const launcher = path.join(managed, "git");
  await writeFile(launcher, githubLauncherSource(), { mode: 0o700 });
  await writeFile(path.join(realBin, "git"), fakeGit, { mode: 0o700 });
  const capture = path.join(root, "capture.json");
  const realGit = (await exec("which", ["git"])).stdout.trim();
  const server = createServer();
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const requests: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
  const respond = (status: number, body: unknown) => {
    server.removeAllListeners("request");
    server.on("request", (req, res) => captureRequest(req, res, status, body));
  };
  async function captureRequest(req: IncomingMessage, res: ServerResponse, status = 200, body: unknown = {}) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = null; }
    requests.push({ path: req.url ?? "", headers: req.headers, body: parsed });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }
  respond(200, { status: "available", env: {
    PAPERCLIP_AZURE_GIT_TOKEN: pat,
    PAPERCLIP_AZURE_GIT_PATH: "contoso/Project/_git/repo",
    GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.useHttpPath", GIT_CONFIG_VALUE_1: "true",
    GIT_CONFIG_KEY_2: "credential.interactive", GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "core.askPass", GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: "http.followRedirects", GIT_CONFIG_VALUE_4: "false",
    GIT_CONFIG_KEY_5: "credential.https://dev.azure.com.helper", GIT_CONFIG_VALUE_5: helper,
  } });
  return { root, managed, launcher, realBin, capture, realGit, requests, setResponse: respond,
    env: (overrides: Record<string, string> = {}) => ({
      ...process.env,
      ...githubBrokerEnvironment({ PATH: `${realBin}${path.delimiter}${process.env.PATH}`, GH_TOKEN: "host-ambient-token" },
        { url: `http://127.0.0.1:${port}`, token: capability }),
      PAPERCLIP_TEST_REAL_GIT: realGit, PAPERCLIP_TEST_CAPTURE: capture,
      PAPERCLIP_TEST_REPOSITORY_URL: azureUrl, PAPERCLIP_TEST_EXPECTED_TOKEN: pat,
      PAPERCLIP_TEST_HOST_TOKEN: "host-ambient-token", PAPERCLIP_TEST_EXPECTED_GITHUB_TOKEN: "github-managed-token", ...overrides,
      GH_CONFIG_DIR: path.join(root, "gh-config"),
    }) };
}

const integration = process.platform === "win32" ? describe.skip : describe;
integration("Azure Git authorization through the shared managed launcher", () => {
  it("requests the exact Azure remote for clone and push origin, and keeps the PAT out of argv and files", async () => {
    const f = await fixture();
    const env = f.env({ PAPERCLIP_TEST_REMOTE_URL: azureUrl });

    const clone = await exec(process.execPath, [f.launcher, "clone", azureUrl], { cwd: f.root, env });
    expect(clone.stdout).toContain("fake git operation completed");
    const cloneResult = JSON.parse(await readFile(f.capture, "utf8"));
    expect(cloneResult, JSON.stringify(cloneResult)).toMatchObject({ args: ["clone", azureUrl], credentialExit: 0, username: "paperclip",
      tokenMatched: true, hostTokenMatched: false, tokenInArgs: false, envHasAzureToken: true });
    expect(clone.stderr).not.toMatch(new RegExp(`${pat}|${capability}`));

    await exec("git", ["init", "-q", f.root]);
    await exec("git", ["-C", f.root, "remote", "add", "origin", azureUrl]);
    const push = await exec(process.execPath, [f.launcher, "-C", f.root, "push", "origin"], { cwd: f.root, env });
    expect(push.stdout).toContain("fake git operation completed");
    const pushResult = JSON.parse(await readFile(f.capture, "utf8"));
    expect(pushResult).toMatchObject({ args: ["-C", f.root, "push", "origin"], credentialExit: 0, username: "paperclip",
      tokenMatched: true, hostTokenMatched: false, tokenInArgs: false, envHasAzureToken: true });

    expect(f.requests.map(item => item.path)).toEqual(["/runtime-tools/git/credentials", "/runtime-tools/git/credentials"]);
    for (const item of f.requests) {
      expect(item.body).toEqual({ repositoryUrl: azureUrl });
      expect(item.headers.authorization).toBe(`Bearer ${capability}`);
      expect(item.headers["x-paperclip-github-capability"]).toBe(capability);
    }
    const allFiles = await readFile(f.capture, "utf8");
    expect(allFiles).not.toContain(pat);
    expect(allFiles).not.toContain(capability);
    expect(await readdir(path.join(f.root, "gh-config"))).toEqual([]);
  });

  it.each(["revoked", "rejected"])("fails closed for an Azure connection that is %s, without ambient fallback", async state => {
    const f = await fixture();
    f.setResponse(state === "rejected" ? 403 : 200, state === "rejected"
      ? { error: "denied; sensitive provider response" }
      : { status: "unavailable", reason: "connection was revoked" });
    const env = f.env({ PAPERCLIP_TEST_REMOTE_URL: azureUrl });
    const result = await exec(process.execPath, [f.launcher, "clone", azureUrl], { cwd: f.root, env }).catch(error => error as Error & { code?: number; stdout?: string; stderr?: string });
    expect(result).toMatchObject({ code: 1 });
    expect(result.stderr).toContain("Azure DevOps repository authorization unavailable");
    expect(result.stderr).not.toMatch(new RegExp(`${pat}|${capability}|host-ambient-token|sensitive provider response`));
    expect(f.requests).toHaveLength(1);
    await expect(readFile(f.capture, "utf8")).rejects.toThrow();
  });

  it("keeps GitHub credential resolution on its existing broker endpoint", async () => {
    const f = await fixture();
    const githubToken = "github-managed-token";
    f.setResponse(200, { status: "available", env: { GH_TOKEN: githubToken } });
    const result = await exec(process.execPath, [f.launcher, "clone", "https://github.com/paperclipai/example.git"], {
      cwd: f.root, env: f.env({ PAPERCLIP_TEST_REPOSITORY_URL: "https://github.com/paperclipai/example.git" }),
    });
    const capture = JSON.parse(await readFile(f.capture, "utf8"));
    expect(capture).toMatchObject({ args: ["clone", "https://github.com/paperclipai/example.git"], envHasGitHubToken: true });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.path).toBe("/runtime-tools/github/credentials");
    expect(f.requests[0]?.body).toEqual({});
    expect(result.stderr).not.toContain(githubToken);
  });
});
