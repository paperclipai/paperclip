import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";

const exec = promisify(execFile);
const roots: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const githubUrl = "https://github.com/example/repo.git";
const azureUrl = "https://dev.azure.com/example/project/_git/repo";
const gitShim = `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('remote') && args.includes('get-url')) {
  let remote = args[args.length - 1] || 'origin';
  try { process.stdout.write(JSON.parse(process.env.PAPERCLIP_TEST_REMOTE_MAP || '{}')[remote] || process.env.PAPERCLIP_TEST_REMOTE || ''); }
  catch { process.stdout.write(process.env.PAPERCLIP_TEST_REMOTE || ''); }
  process.exit(0);
}
if (args.includes('status') || args.includes('commit') || (args.includes('remote') && args.includes('-v'))) {
  const result = spawnSync(process.env.PAPERCLIP_REAL_GIT, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
process.stdout.write('git operation reached executable\\n');
`;

async function fixture(response: unknown = { status: "unavailable", reason: "No GitHub connection" }, options: { hostGitHub?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-strict-launcher-"));
  roots.push(root);
  const managed = path.join(root, "managed"), real = path.join(root, "real");
  await mkdir(managed); await mkdir(real);
  const realGit = (await exec("which", ["git"])).stdout.trim();
  await writeFile(path.join(managed, "git"), githubLauncherSource({ requireGitHubConnection: true, hostGitHub: options.hostGitHub }), { mode: 0o700 });
  await writeFile(path.join(managed, "gh"), githubLauncherSource({ requireGitHubConnection: true, hostGitHub: options.hostGitHub }), { mode: 0o700 });
  await writeFile(path.join(real, "git"), gitShim, { mode: 0o700 });
  await writeFile(path.join(real, "gh"), `#!${process.execPath}\nprocess.stdout.write('gh reached executable\\n');`, { mode: 0o700 });

  let body = response;
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    let requestBody: unknown;
    try { requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { requestBody = null; }
    requests.push({ path: req.url ?? "", body: requestBody });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const env = (overrides: Record<string, string> = {}) => ({
    ...process.env,
    ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "synthetic-run-capability" }),
    PATH: `${managed}${path.delimiter}${real}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`,
    PAPERCLIP_REAL_GIT: realGit,
    PAPERCLIP_TEST_REMOTE: githubUrl,
    ...(options.hostGitHub ? { GH_TOKEN: "synthetic-host-token", PAPERCLIP_GITHUB_AUTH_MODE: "managed" } : {}),
    ...overrides,
  });
  const git = (...args: string[]) => exec(path.join(managed, "git"), args, { cwd: root, env: env() });
  const gitWithEnv = (overrides: Record<string, string>, ...args: string[]) =>
    exec(path.join(managed, "git"), args, { cwd: root, env: env(overrides) });
  const gh = (...args: string[]) => exec(path.join(managed, "gh"), args, { cwd: root, env: env() });
  return { root, env, git, gitWithEnv, gh, requests, setResponse(value: unknown) { body = value; } };
}

describe.skipIf(process.platform === "win32")("strict project GitHub launcher", () => {
  it.each(["clone", "fetch", "push", "gh"])("fails a GitHub %s operation when broker authorization is unavailable", async operation => {
    const f = await fixture();
    const run = operation === "clone" ? f.git("clone", githubUrl, path.join(f.root, "clone"))
      : operation === "fetch" ? f.git("fetch", "origin")
      : operation === "push" ? f.git("push", "origin", "HEAD")
      : f.gh("repo", "view");
    await expect(run).rejects.toMatchObject({ code: 1 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.path).toBe("/runtime-tools/github/credentials");
  });

  it.each(["clone", "fetch", "push", "gh"])("fails a GitHub %s operation when broker configuration is absent", async operation => {
    const f = await fixture();
    const env = f.env({ PAPERCLIP_GITHUB_BROKER_URL: "", PAPERCLIP_GITHUB_BROKER_TOKEN: "" });
    const command = operation === "clone" ? exec(path.join(f.root, "managed", "git"), ["clone", githubUrl, path.join(f.root, "clone")], { cwd: f.root, env })
      : operation === "fetch" ? exec(path.join(f.root, "managed", "git"), ["fetch", githubUrl], { cwd: f.root, env })
      : operation === "push" ? exec(path.join(f.root, "managed", "git"), ["push", githubUrl], { cwd: f.root, env })
      : exec(path.join(f.root, "managed", "gh"), ["repo", "view"], { cwd: f.root, env });
    await expect(command).rejects.toMatchObject({ code: 1 });
    expect(f.requests).toHaveLength(0);
  });

  it("fails ls-remote for a GitHub named remote when authorization is unavailable", async () => {
    const f = await fixture();
    await expect(f.gitWithEnv({ PAPERCLIP_TEST_REMOTE_MAP: JSON.stringify({ origin: githubUrl }) }, "ls-remote", "origin"))
      .rejects.toMatchObject({ code: 1 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.path).toBe("/runtime-tools/github/credentials");
  });

  it("keeps local git status available without contacting the broker", async () => {
    const f = await fixture();
    await exec("git", ["init", "-q", f.root]);
    const result = await f.git("-C", f.root, "status", "--short");
    expect(result.stdout).toContain("??");
    expect(f.requests).toHaveLength(0);
  });

  it("uses the Azure credential broker path independently of strict GitHub authorization", async () => {
    const f = await fixture({ status: "available", env: { PAPERCLIP_AZURE_GIT_TOKEN: "synthetic-azure-token", PAPERCLIP_AZURE_GIT_PATH: "example/project/_git/repo" } });
    await f.git("clone", azureUrl, path.join(f.root, "azure"));
    expect(f.requests).toEqual([{ path: "/runtime-tools/git/credentials", body: { repositoryUrl: azureUrl } }]);
  });

  it("does not reuse prior GitHub credentials when access is later revoked and keeps local and Azure Git usable", async () => {
    const f = await fixture({ status: "available", env: { GH_TOKEN: "synthetic-github-token" } });
    await f.git("clone", githubUrl, path.join(f.root, "github"));
    expect(f.requests[0]?.path).toBe("/runtime-tools/github/credentials");

    f.setResponse({ status: "unavailable", reason: "connection revoked" });
    await expect(f.git("fetch", "origin")).rejects.toMatchObject({ code: 1 });
    expect(f.requests[1]?.path).toBe("/runtime-tools/github/credentials");

    await exec("git", ["init", "-q", f.root]);
    const status = await f.git("-C", f.root, "status", "--short");
    expect(status.stdout).toContain("??");
    await exec("git", ["-C", f.root, "remote", "add", "origin", githubUrl]);
    const remotes = await f.git("-C", f.root, "remote", "-v");
    expect(remotes.stdout).toContain(`origin\t${githubUrl}`);
    await writeFile(path.join(f.root, "local.txt"), "local work\n");
    await exec("git", ["-C", f.root, "add", "local.txt"]);
    await f.git("-C", f.root, "commit", "-m", "Local work");
    expect((await exec("git", ["-C", f.root, "show", "HEAD:local.txt"])).stdout).toBe("local work\n");
    expect(f.requests).toHaveLength(4);

    f.setResponse({ status: "available", env: {
      PAPERCLIP_AZURE_GIT_TOKEN: "synthetic-azure-token",
      PAPERCLIP_AZURE_GIT_PATH: "example/project/_git/repo",
    } });
    await f.git("clone", azureUrl, path.join(f.root, "azure"));
    expect(f.requests[4]?.path).toBe("/runtime-tools/git/credentials");
  });

  it("classifies named GitHub and GitLab remotes independently with git -C", async () => {
    const f = await fixture();
    const remoteMap = JSON.stringify({ origin: githubUrl, gitlab: "https://gitlab.com/example/repo.git" });
    await expect(f.gitWithEnv({ PAPERCLIP_TEST_REMOTE_MAP: remoteMap }, "-C", f.root, "fetch", "origin"))
      .rejects.toMatchObject({ code: 1 });
    expect(f.requests[0]?.path).toBe("/runtime-tools/github/credentials");

    const gitlab = await f.gitWithEnv({ PAPERCLIP_TEST_REMOTE_MAP: remoteMap }, "-C", f.root, "fetch", "gitlab");
    expect(gitlab.stdout).toContain("git operation reached executable");
    expect(f.requests[1]?.path).toBe("/runtime-tools/github/credentials");
  });

  it("does not let hostGitHub mode bypass strict project authorization", async () => {
    const f = await fixture({ status: "unavailable", reason: "No GitHub connection" }, { hostGitHub: true });
    await expect(f.git("clone", githubUrl, path.join(f.root, "clone"))).rejects.toMatchObject({ code: 1 });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.path).toBe("/runtime-tools/github/credentials");
  });

  it("does not let absent GitHub authorization block a GitLab remote operation", async () => {
    const f = await fixture();
    const gitlabUrl = "https://gitlab.com/example/repo.git";
    const result = await f.git("clone", gitlabUrl, path.join(f.root, "gitlab"));
    expect(result.stdout).toContain("git operation reached executable");
    expect(f.requests.every(request => request.path !== "/runtime-tools/git/credentials")).toBe(true);
  });
});
