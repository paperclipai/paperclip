import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
  it("snapshots a staged tree and reports unstaged files without capturing GitHub credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-snapshot-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), repo = path.join(root, "repo");
    await mkdir(bin); await mkdir(repo);
    await exec("git", ["init", "-q", repo]);
    await writeFile(path.join(repo, "tracked.txt"), "staged contents\n");
    await exec("git", ["-C", repo, "add", "tracked.txt"]);
    const expectedTree = (await exec("git", ["-C", repo, "write-tree"])).stdout;
    await writeFile(path.join(repo, "tracked.txt"), "unstaged contents\n");
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    let captures = 0;
    const server = createServer((_req, res) => {
      captures++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "unavailable", reason: "No GitHub connection" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }), PATH: `${bin}:${process.env.PATH}` };
    const git = (...args: string[]) => exec(path.join(bin, "git"), args, { cwd: root, env });
    const tree = await git("--git-dir", path.join(repo, ".git"), "--work-tree", repo, "write-tree");
    const diff = await git("-C", repo, "-c", "core.quotepath=false", "diff-files", "--name-only", "-z", "--", ".");
    expect(tree.stdout).toBe(expectedTree);
    expect(diff.stdout).toBe("tracked.txt\0");
    expect(captures).toBe(0);
  });

  it.each(["missing", "absent", "unavailable", "rejected"])("commits local work without an identity when GitHub access is %s", async (access) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-default-author-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => {
      res.writeHead(access === "rejected" ? 403 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: access, env: {
        GH_TOKEN: "rejected-token", GIT_AUTHOR_NAME: "Rejected", GIT_AUTHOR_EMAIL: "rejected@example.test",
        GIT_COMMITTER_NAME: "Rejected", GIT_COMMITTER_EMAIL: "rejected@example.test",
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
      GIT_COMMITTER_NAME: "Host", GIT_COMMITTER_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${port}`, token: access === "missing" ? "" : "run-capability" }),
      PATH: `${bin}:${process.env.PATH}` };
    await writeFile(path.join(root, "work.txt"), "saved work\n");
    await exec(path.join(bin, "git"), ["add", "work.txt"], { cwd: root, env });
    await exec(path.join(bin, "git"), ["commit", "-m", "Save local work"], { cwd: root, env });
    expect((await exec("git", ["-C", root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.trim())
      .toBe("Paperclip <noreply@paperclip.ing>|Paperclip <noreply@paperclip.ing>");
    expect((await exec("git", ["-C", root, "show", "HEAD:work.txt"])).stdout).toBe("saved work\n");
    await expect(exec("git", ["-C", root, "config", "--local", "--get", "user.name"])).rejects.toThrow();
    await expect(exec("git", ["-C", root, "config", "--local", "--get", "user.email"])).rejects.toThrow();
  });
  it.each(["repository", "command"])("uses explicit %s identity for local commits without managed credentials", async (identitySource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-identity-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const env = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "host-token", GIT_AUTHOR_NAME: "Host", GIT_COMMITTER_NAME: "Host",
    }, { url: "", token: "" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: root, env })).stdout.trim();
    expect(await git("var", "GIT_AUTHOR_IDENT")).toMatch(/^Paperclip <noreply@paperclip.ing>/);
    expect(await git("var", "GIT_COMMITTER_IDENT")).toMatch(/^Paperclip <noreply@paperclip.ing>/);
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await exec("git", ["init", root]);
    await exec("git", ["-C", root, "config", "user.name", "Local Author"]);
    await exec("git", ["-C", root, "config", "user.email", "local@example.test"]);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    const server = createServer((_req, res) => { res.writeHead(403); res.end(); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    if (failure === "broker-offline") await new Promise<void>(resolve => server.close(() => resolve()));
    else cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const configRoot = path.join(root, "config");
    if (failure === "config-unwritable") await writeFile(configRoot, "not a directory");
    const result = await exec(path.join(bin, "git"), ["remote"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
  }, 15_000); // broker-offline retries the transport twice per command before it falls back

  it("explains unavailable access while allowing local work without credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-diagnostic-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    const server = createServer((_req,res) => {
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"unavailable",reason:"More than one managed GitHub identity matches this run",env:{GH_TOKEN:"must-not-be-used"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:null});
    expect(result.stderr).toContain("More than one managed GitHub identity matches this run");
    expect(result.stderr).not.toMatch(/host-token|must-not-be-used|run-capability/);
  });
  it.each(["before-write", "partial-write"])("keeps Git and managed credentials available after a %s failure", async (failure) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-default-write-failure-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await exec("git", ["init", root]);
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(process.env.GH_TOKEN || "anonymous");', { mode: 0o700 });
    const fault = path.join(root, "write-fault.cjs");
    await writeFile(fault, `const fs = require('node:fs'); const write = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => {
  if (String(file).endsWith('/gitconfig')) {
    if (${failure === "partial-write"}) write(file, '[user', { mode: 0o600 });
    throw new Error('fixture disk full');
  }
  return write(file, ...args);
};`);
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "managed-token" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PATH: `${bin}:${realBin}:${process.env.PATH}`,
    };
    const result = await exec(process.execPath, ["--require", fault, path.join(bin, "gh")], { cwd: root, env });
    expect(result.stdout).toBe("managed-token");
    expect(result.stderr).toContain("configuration_directory_unavailable");
    const git = (...args: string[]) => exec(process.execPath, ["--require", fault, path.join(bin, "git"), ...args], { cwd: root, env });
    expect((await git("status", "--porcelain", "--untracked-files=no")).stdout).toBe("");
    await expect(git("commit", "--allow-empty", "-m", "No default")).rejects.toMatchObject({ stderr: expect.stringContaining("Author identity unknown") });
    await git("-c", "user.name=Explicit", "-c", "user.email=explicit@example.test", "commit", "--allow-empty", "-m", "Explicit identity");
    expect((await exec("git", ["-C", root, "log", "-1", "--format=%an <%ae>|%cn <%ce>"])).stdout.trim())
      .toBe("Explicit <explicit@example.test>|Explicit <explicit@example.test>");
  });
  // The first broker request fails, the second succeeds: the managed token must still reach gh.
  it.each([
    ["connection drops before the response", (res: import("node:http").ServerResponse) => { res.socket?.destroy(); }],
    ["body read fails mid-response", (res: import("node:http").ServerResponse) => {
      res.writeHead(200, {"content-type":"application/json"}); res.write('{"status":'); setTimeout(() => res.socket?.destroy(), 20);
    }],
  ])("retries when the %s and still uses managed credentials", async (_label, fail) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-retry-"));
    cleanups.push(() => rm(root, {recursive:true,force:true}));
    const bin = path.join(root,"managed"), realBin = path.join(root,"real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin,"gh"), githubLauncherSource(), {mode:0o700});
    await writeFile(path.join(realBin,"gh"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({token:process.env.GH_TOKEN ?? null}));', {mode:0o700});
    let requests = 0;
    const server = createServer((_req,res) => {
      requests++;
      if (requests === 1) return fail(res);
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({status:"available",env:{GH_TOKEN:"managed-token"}}));
    });
    await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const {port} = server.address() as {port:number};
    const result = await exec(path.join(bin,"gh"), [], {env:{...process.env,...githubBrokerEnvironment({GH_TOKEN:"host-token"},{url:`http://127.0.0.1:${port}`,token:"run-capability"}),PATH:`${bin}:${realBin}:${process.env.PATH}`}});
    expect(JSON.parse(result.stdout)).toEqual({token:"managed-token"});
    expect(requests).toBe(2);
    expect(result.stderr).not.toContain("broker_transport_unavailable");
    expect(result.stderr).not.toMatch(/host-token|run-capability/);
  });
  it("captures each command's identity and clears host credentials when the next person has none", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-launcher-test-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real"), repo = path.join(root, "repo");
    for (const dir of [bin, realBin, repo, path.join(bin, "gh-config")]) await mkdir(dir, { recursive: true });
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const {execFileSync}=require('node:child_process');
const identity=execFileSync('git',['var','GIT_AUTHOR_IDENT'],{encoding:'utf8'}).trim();
process.stdout.write(JSON.stringify({identity, token:process.env.GH_TOKEN ?? null, global:process.env.GIT_CONFIG_GLOBAL, config:process.env.GH_CONFIG_DIR}));
`, { mode: 0o700 });
    let user: string | null = "A", captures = 0;
    let heldCapture: (() => void) | null = null;
    let releaseCapture: (() => void) | null = null;
    const server = createServer((req, res) => {
      captures++;
      expect(req.headers.authorization).toBe("Bearer run-capability");
      const selected = user;
      res.setHeader("content-type", "application/json");
      const finish = () => res.end(JSON.stringify(selected ? { status: "available", env: {
        GH_TOKEN: `credential-${selected}`, GITHUB_TOKEN: `credential-${selected}`,
        GIT_AUTHOR_NAME: selected, GIT_AUTHOR_EMAIL: `${selected}@example.test`,
        GIT_COMMITTER_NAME: selected, GIT_COMMITTER_EMAIL: `${selected}@example.test`,
      } } : { status: "absent", env: {} }));
      if (heldCapture) { const captured = heldCapture; heldCapture = null; releaseCapture = finish; captured(); }
      else finish();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address() as { port: number };
    const env: NodeJS.ProcessEnv = { ...process.env, ...githubBrokerEnvironment({
      GH_TOKEN: "ambient-host-token", GIT_AUTHOR_NAME: "Host", GIT_AUTHOR_EMAIL: "host@example.test",
    }, { url: `http://127.0.0.1:${address.port}`, token: "run-capability" }), PATH: `${bin}:${realBin}:${process.env.PATH}` };
    const git = async (...args: string[]) => (await exec(path.join(bin, "git"), args, { cwd: repo, env })).stdout.trim();
    await git("init");
    await git("config", "user.name", "Repository Author");
    await git("config", "user.email", "repository@example.test");
    await git("commit", "--allow-empty", "-m", "A");
    user = "B";
    await git("commit", "--allow-empty", "-m", "B");
    user = "A";
    await git("commit", "--allow-empty", "-m", "A again");
    expect(await git("log", "--format=%an <%ae>|%cn <%ce>" )).toBe("A <A@example.test>|A <A@example.test>\nB <B@example.test>|B <B@example.test>\nA <A@example.test>|A <A@example.test>");
    const before = captures;
    const gh = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(gh.identity).toContain("A <A@example.test>");
    expect(gh.token).toBe("credential-A");
    expect(captures - before).toBe(1); // gh's child Git retains the same capture.
    const captured = new Promise<void>(resolve => { heldCapture = resolve; });
    const operationA = exec(path.join(bin, "gh"), [], { cwd: repo, env });
    await captured;
    user = "B";
    const operationB = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    releaseCapture!();
    const completedA = JSON.parse((await operationA).stdout);
    expect(completedA.token).toBe("credential-A");
    expect(operationB.token).toBe("credential-B");
    expect(completedA.config).not.toBe(operationB.config);
    user = null;
    await git("commit", "--allow-empty", "-m", "Local identity");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Repository Author <repository@example.test>|Repository Author <repository@example.test>");
    const anonymous = JSON.parse((await exec(path.join(bin, "gh"), [], { cwd: repo, env })).stdout);
    expect(anonymous.token).toBeNull();
    await git("config", "--unset", "user.name");
    await git("config", "--unset", "user.email");
    await git("commit", "--allow-empty", "-m", "Default identity after revocation");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Paperclip <noreply@paperclip.ing>|Paperclip <noreply@paperclip.ing>");
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });
  it("keeps local Git commands off the broker and still asks for the rest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-local-skip-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    await writeFile(path.join(bin, "git"), githubLauncherSource(), { mode: 0o700 });
    let posts = 0;
    const server = createServer((_req, res) => {
      posts++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: {
        GH_TOKEN: "managed-token", GIT_AUTHOR_NAME: "Managed", GIT_AUTHOR_EMAIL: "managed@example.test",
        GIT_COMMITTER_NAME: "Managed", GIT_COMMITTER_EMAIL: "managed@example.test",
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }), PATH: `${bin}:${process.env.PATH}` };
    const git = async (...args: string[]) => {
      const before = posts;
      const { stdout } = await exec(path.join(bin, "git"), args, { cwd: root, env }).catch(() => ({ stdout: "" }));
      return { stdout: stdout.trim(), posts: posts - before };
    };
    for (const args of [
      ["init", "-q", "repo"],
      ["-C", "repo", "status", "--short"],
      ["-C", "repo", "-c", "core.quotepath=off", "--no-pager", "diff"],
      ["--git-dir=repo/.git", "rev-parse", "--git-dir"],
      ["--git-dir", "repo/.git", "--work-tree", "repo", "status"],
      ["-C", "repo", "config", "user.useConfigOnly"],
      ["--version"],
    ]) expect((await git(...args)).posts, args.join(" ")).toBe(0);
    expect((await git("-C", "repo", "config", "user.useConfigOnly")).stdout).toBe("true");
    for (const args of [
      ["-C", "repo", "remote"],
      ["-C", "repo", "var", "GIT_AUTHOR_IDENT"],
      ["-C", "repo", "fetch", "--dry-run"],
      ["-C", "repo", "-c", "alias.noop=!true", "noop"],
      ["-C", "repo", "--unknown-option", "status"],
      ["-C"],
    ]) expect((await git(...args)).posts, args.join(" ")).toBe(1);
    expect((await git("-C", "repo", "var", "GIT_AUTHOR_IDENT")).stdout).toMatch(/^Managed <managed@example.test>/);
    expect((await git("-C", "repo", "commit", "--allow-empty", "-m", "Managed work")).posts).toBe(1);
    expect((await git("-C", "repo", "log", "-1", "--format=%an <%ae>")).stdout).toBe("Managed <managed@example.test>");
  }, 20_000);
});

it("captures the current task broker file once per invocation and never falls back to inherited authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-task-github-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "managed"), real = path.join(root, "real");
  await mkdir(bin); await mkdir(real);
  await writeFile(path.join(bin, "gh"), githubLauncherSource({ brokerFile: true }), { mode: 0o700 });
  await writeFile(path.join(real, "gh"), '#!/usr/bin/env node\nprocess.stdout.write(process.env.GH_TOKEN || "anonymous");\n', { mode: 0o700 });
  const captured: string[] = [];
  const server = createServer((req, res) => {
    captured.push(req.headers.authorization!);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: req.headers.authorization!.slice(7) + "-credential" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ...process.env, PATH: `${bin}:${real}:${process.env.PATH}`, GH_TOKEN: "ambient-secret",
    PAPERCLIP_GITHUB_BROKER_URL: url, PAPERCLIP_GITHUB_BROKER_TOKEN: "stale-capability", PAPERCLIP_API_KEY: "unrelated-api-key" };
  const run = () => exec(path.join(bin, "gh"), [], { env });
  for (const token of ["first-run", "next-run"]) {
    await writeFile(path.join(bin, "broker.json"), JSON.stringify({ url, token }));
    expect((await run()).stdout).toBe(token + "-credential");
  }
  await rm(path.join(bin, "broker.json"));
  expect((await run()).stdout).toBe("anonymous");
  expect(captured).toEqual(["Bearer first-run", "Bearer next-run"]);
});
