import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherCommandSource, githubLauncherSource } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe.skipIf(process.platform === "win32")("managed GitHub launchers", () => {
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
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });
});

describe.runIf(process.platform === "win32")("managed GitHub launchers on Windows", () => {
  const stage = async (prefix: string) => {
    const root = await mkdtemp(path.join(os.tmpdir(), prefix));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    // A real gh.exe stand-in: Windows discovery requires an executable image.
    await copyFile(process.execPath, path.join(realBin, "gh.exe"));
    return { root, bin, realBin };
  };
  const broker = async (token: string) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: token } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    return server.address() as { port: number };
  };
  it("discovers gh.exe via PATHEXT on a semicolon-joined PATH", async () => {
    const { bin, realBin } = await stage("paperclip-github-win-");
    const { port } = await broker("credential-windows");
    const env = { ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "host-token" }, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PAPERCLIP_API_URL: "", PATH: [bin, realBin, process.env.PATH].join(";") };
    const result = await exec(process.execPath, [path.join(bin, "gh"), "-e", "process.stdout.write(JSON.stringify({token:process.env.GH_TOKEN??null}))"], { env });
    expect(JSON.parse(result.stdout)).toEqual({ token: "credential-windows" });
  });
  it("resolves a colon-joined POSIX-style PATH handed over by Git Bash", async () => {
    const { root, bin, realBin } = await stage("paperclip-github-win-posix-");
    const { port } = await broker("credential-posix-path");
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PAPERCLIP_API_URL: "", PATH: ["managed", "real"].join(":") };
    const result = await exec(process.execPath, [path.join(bin, "gh"), "-e", "process.stdout.write(process.env.GH_TOKEN)"], { cwd: root, env });
    expect(result.stdout).toBe("credential-posix-path");
  });
  it("runs the staged .cmd wrapper from cmd.exe", async () => {
    const { bin, realBin } = await stage("paperclip-github-win-cmd-");
    await writeFile(path.join(bin, "gh.cmd"), githubLauncherCommandSource(process.execPath, "gh"));
    const { port } = await broker("credential-cmd");
    const env = { ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      PAPERCLIP_API_URL: "", PATH: [bin, realBin, process.env.PATH].join(";") };
    const result = await exec("cmd.exe", ["/d", "/c", path.join(bin, "gh.cmd"), "-e", "process.stdout.write(process.env.GH_TOKEN)"], { env });
    expect(result.stdout).toBe("credential-cmd");
  });
  it("still exits 127 when no real GitHub binary is installed", async () => {
    const { bin } = await stage("paperclip-github-win-missing-");
    const env = { ...process.env, PATH: bin };
    await expect(exec(process.execPath, [path.join(bin, "gh")], { env }))
      .rejects.toMatchObject({ code: 127, stderr: expect.stringContaining("not installed") });
  });
});
