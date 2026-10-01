import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
import { GITHUB_BROKER_SEALED_HEADER, openSealedGitHubBrokerRequest, sealGitHubBrokerResponse } from "./github-broker-seal.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("managed GitHub launchers", () => {
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
    // No configured identity must fail, rather than guessing the host user's.
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    await expect(git("var", "GIT_COMMITTER_IDENT")).rejects.toThrow();
    if (identitySource === "repository") {
      await git("config", "user.name", "Local Author");
      await git("config", "user.email", "local@example.test");
    }
    await git(...(identitySource === "command" ? ["-c", "user.name=Local Author", "-c", "user.email=local@example.test"] : []),
      "commit", "--allow-empty", "-m", "Local work");
    expect(await git("log", "-1", "--format=%an <%ae>|%cn <%ce>"))
      .toBe("Local Author <local@example.test>|Local Author <local@example.test>");
  });

  it.each(["broker-offline", "config-unwritable", "config-fallback", "capability-rejected"])("keeps real local Git usable when %s", async (failure) => {
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
    if (failure === "config-unwritable" || failure === "config-fallback") await writeFile(configRoot, "not a directory");
    // An unwritable GH_CONFIG_DIR falls back to the OS temp dir; only both failing is reported.
    const tempRoot = failure === "config-unwritable" ? configRoot : os.tmpdir();
    const result = await exec(path.join(bin, "git"), ["status", "--porcelain"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({ GH_TOKEN: "host-must-not-leak" }, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, TMPDIR: tempRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
    expect(result.stderr).toContain(failure === "broker-offline" ? "broker_transport_unavailable" : failure === "config-unwritable" ? "configuration_directory_unavailable" : "capability_rejected");
    if (failure === "config-fallback") expect(result.stderr).not.toContain("configuration_directory_unavailable");
    expect(result.stderr).not.toMatch(/host-must-not-leak|private-capability/);
    await exec(path.join(bin, "git"), ["commit", "--allow-empty", "-m", "Offline work"], { cwd: root, env: {
      ...process.env, ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "private-capability" }),
      GH_CONFIG_DIR: configRoot, PATH: `${bin}:${process.env.PATH}`,
    } });
  });

  // Capabilities are HS256 `header.claims.signature`; only the signature is secret.
  const SIGNING_SECRET = "test-signing-secret";
  const signatureFor = (unsigned: string) => createHmac("sha256", SIGNING_SECRET).update(unsigned).digest("base64url");
  const unsignedCapability = ["{\"alg\":\"HS256\"}", "{\"run_id\":\"run-1\"}"].map(part => Buffer.from(part).toString("base64url")).join(".");
  const capabilitySignature = signatureFor(unsignedCapability);
  const runCapability = `${unsignedCapability}.${capabilitySignature}`;
  const secrets = [capabilitySignature, runCapability, "agent-api-key", "Bearer", "x-paperclip-github-capability"];

  // Claude Code's Seatbelt sandbox denies direct sockets with EPERM. Reproduce that
  // failure without a sandbox by preloading an http(s).request that fails the same
  // way for the launcher's direct attempt (agent: false). CONNECT and tunnel
  // requests still reach the real network stack.
  async function sandboxLauncher(root: string) {
    const bin = path.join(root, "managed"), realBin = path.join(root, "real");
    await mkdir(bin); await mkdir(realBin);
    await writeFile(path.join(bin, "gh"), githubLauncherSource(), { mode: 0o700 });
    await writeFile(path.join(realBin, "gh"), `#!/usr/bin/env node
const env = process.env, count = Number(env.GIT_CONFIG_COUNT);
const config = Array.from({ length: count }, (_, i) => env['GIT_CONFIG_KEY_' + i] + '=' + env['GIT_CONFIG_VALUE_' + i]);
process.stdout.write(JSON.stringify({ token: env.GH_TOKEN ?? null, config }));
`, { mode: 0o700 });
    const denyDirect = path.join(root, "deny-direct-sockets.cjs");
    await writeFile(denyDirect, `for (const name of ['node:http', 'node:https']) {
  const mod = require(name), original = mod.request;
  mod.request = function (options, ...rest) {
    if (options && options.agent === false && options.method !== 'CONNECT') {
      const { EventEmitter } = require('node:events');
      const request = new EventEmitter();
      request.end = () => setImmediate(() => request.emit('error', Object.assign(new Error('connect EPERM'), { code: 'EPERM' })));
      request.destroy = () => {};
      return request;
    }
    return original.call(this, options, ...rest);
  };
}
`);
    return async (brokerUrl: string, proxyEnv: Record<string, string>, options: { sandboxed: boolean } = { sandboxed: true }) => {
      const result = await exec(path.join(bin, "gh"), [], { env: {
        ...process.env, HTTP_PROXY: "", http_proxy: "", HTTPS_PROXY: "", https_proxy: "", NODE_USE_ENV_PROXY: "",
        ...githubBrokerEnvironment({}, { url: brokerUrl, token: runCapability }),
        PAPERCLIP_API_KEY: "agent-api-key", ...proxyEnv,
        NODE_OPTIONS: options.sandboxed ? `--require ${denyDirect}` : "",
        PATH: `${bin}:${realBin}:${process.env.PATH}`,
      } });
      return { stderr: result.stderr, output: JSON.parse(result.stdout) as { token: string | null; config: string[] } };
    };
  }

  // The real broker's sealed path, reduced to the crypto contract.
  async function sealingBroker() {
    const seen: Array<{ method?: string; url?: string; headers: Record<string, unknown> }> = [];
    const broker = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.setHeader("content-type", "application/json");
      const opened = openSealedGitHubBrokerRequest(req.headers[GITHUB_BROKER_SEALED_HEADER], "/runtime-tools/github/credentials", (unsigned) => unsigned === unsignedCapability ? signatureFor(unsigned) : null);
      if (!opened) { res.statusCode = 401; res.end("{}"); return; }
      res.end(JSON.stringify(sealGitHubBrokerResponse(opened, { status: "available", env: { GH_TOKEN: "brokered-token" } })));
    });
    await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { broker.closeAllConnections(); broker.close(() => resolve()); }));
    return { seen, port: (broker.address() as AddressInfo).port };
  }

  // Records everything a proxy receives: absolute-form requests, CONNECT
  // requests, every byte sent through an accepted tunnel and every byte returned.
  // `tunnelTo` relays to a port; `answer` replies itself, as a rogue broker would.
  async function recordingProxy(host = "127.0.0.1", options: { tunnelTo?: number; answer?: string } = {}) {
    const seen: Array<{ method?: string; target?: string; headers: Record<string, unknown>; bytes: Buffer; returned: Buffer }> = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, target: req.url, headers: req.headers, bytes: Buffer.alloc(0), returned: Buffer.alloc(0) });
      res.statusCode = 502; res.end();
    });
    server.on("connect", (req, socket, head: Buffer) => {
      const entry = { method: req.method, target: req.url, headers: req.headers, bytes: head, returned: Buffer.alloc(0) };
      seen.push(entry);
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => { entry.bytes = Buffer.concat([entry.bytes, chunk]); });
      if (options.tunnelTo) {
        const upstream = connect(options.tunnelTo, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
        });
        upstream.on("data", (chunk: Buffer) => { entry.returned = Buffer.concat([entry.returned, chunk]); });
        upstream.on("error", () => socket.destroy());
        return;
      }
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        if (options.answer === undefined) { socket.destroy(); return; }
        socket.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(options.answer)}\r\nconnection: close\r\n\r\n${options.answer}`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, host, resolve));
    cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    return { seen, port: (server.address() as AddressInfo).port };
  }

  async function closedPort() {
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    return port;
  }

  it("gets sealed credentials through the loopback sandbox proxy without sending any reusable secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-proxy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const run = await sandboxLauncher(root);
    const broker = await sealingBroker();
    const proxy = await recordingProxy("127.0.0.1", { tunnelTo: broker.port });
    const proxyUrl = `http://proxy-user:proxy%20pass@127.0.0.1:${proxy.port}`;
    const { stderr, output } = await run(`http://127.0.0.1:${broker.port}`, { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl });
    expect(output.token).toBe("brokered-token");
    expect(output.config).toContain("http.proxyAuthMethod=basic");
    expect(stderr).not.toContain("broker_transport_unavailable");
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toMatchObject({ method: "CONNECT", target: `127.0.0.1:${broker.port}` });
    expect(proxy.seen[0].headers["proxy-authorization"]).toBe(`Basic ${Buffer.from("proxy-user:proxy pass").toString("base64")}`);
    // Everything the proxy could observe in either direction.
    for (const secret of secrets) expect(proxy.seen[0].bytes.includes(secret)).toBe(false);
    expect(proxy.seen[0].bytes.includes(GITHUB_BROKER_SEALED_HEADER)).toBe(true);
    expect(proxy.seen[0].returned.includes("brokered-token")).toBe(false);
    expect(broker.seen).toHaveLength(1);
    expect(broker.seen[0].headers).not.toHaveProperty("authorization");
    expect(broker.seen[0].headers).not.toHaveProperty("x-paperclip-github-capability");
  });

  it("gives an overridden loopback proxy nothing reusable and rejects credentials it forges", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-rogue-loopback-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const run = await sandboxLauncher(root);
    // The agent repointed HTTP_PROXY at a loopback listener it (or another tenant) controls.
    const rogue = await recordingProxy("127.0.0.1", { answer: JSON.stringify({ status: "available", env: { GH_TOKEN: "rogue-token" } }) });
    const rogueUrl = `http://127.0.0.1:${rogue.port}`;
    const { stderr, output } = await run(`http://127.0.0.1:${await closedPort()}`, { HTTP_PROXY: rogueUrl, http_proxy: rogueUrl });
    expect(output.token).toBeNull();
    expect(stderr).toContain("broker_transport_unavailable");
    expect(rogue.seen).toHaveLength(1);
    expect(rogue.seen[0].method).toBe("CONNECT");
    for (const secret of secrets) expect(rogue.seen[0].bytes.includes(secret)).toBe(false);
  });

  it("keeps the direct broker call direct when NODE_USE_ENV_PROXY points it at an overridden proxy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-env-proxy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const run = await sandboxLauncher(root);
    const directSeen: Array<string | string[] | undefined> = [];
    const broker = createServer((req, res) => {
      directSeen.push(req.headers["x-paperclip-github-capability"]);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: { GH_TOKEN: "direct-token" } }));
    });
    await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => { broker.closeAllConnections(); broker.close(() => resolve()); }));
    const rogue = await recordingProxy();
    const rogueUrl = `http://127.0.0.1:${rogue.port}`;
    const { output } = await run(`http://127.0.0.1:${(broker.address() as AddressInfo).port}`, {
      NODE_USE_ENV_PROXY: "1", NO_PROXY: "", no_proxy: "", HTTP_PROXY: rogueUrl, http_proxy: rogueUrl,
    }, { sandboxed: false });
    expect(output.token).toBe("direct-token");
    expect(directSeen).toEqual([runCapability]);
    expect(rogue.seen).toEqual([]);
  });

  it.each([
    ["the overridden proxy is not on loopback", { sandboxed: true, proxyHost: "0.0.0.0", scheme: "http", broker: "loopback" }],
    ["the overridden proxy is not plain HTTP", { sandboxed: true, proxyHost: "127.0.0.1", scheme: "https", broker: "loopback" }],
    ["the direct failure is not a sandbox denial", { sandboxed: false, proxyHost: "127.0.0.1", scheme: "http", broker: "loopback" }],
    ["a plain-HTTP broker is not on loopback", { sandboxed: true, proxyHost: "127.0.0.1", scheme: "http", broker: "remote" }],
  ] as const)("never contacts HTTP_PROXY when %s", async (_case, scenario) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-rogue-proxy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const run = await sandboxLauncher(root);
    const rogue = await recordingProxy(scenario.proxyHost === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1");
    const rogueUrl = `${scenario.scheme}://rogue:rogue@${scenario.proxyHost}:${rogue.port}`;
    const brokerUrl = scenario.broker === "loopback" ? `http://127.0.0.1:${await closedPort()}` : "http://broker.example.test";
    const { stderr, output } = await run(brokerUrl, { HTTP_PROXY: rogueUrl, http_proxy: rogueUrl }, { sandboxed: scenario.sandboxed });
    expect(stderr).toContain("broker_transport_unavailable");
    expect(output.token).toBeNull();
    expect(rogue.seen).toEqual([]);
  });

  it("retries an unreachable HTTPS broker through the sandbox proxy inside end-to-end TLS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-https-proxy-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const run = await sandboxLauncher(root);
    const proxy = await recordingProxy();
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    // No preload: .test never resolves, like the sandbox's denied DNS.
    const { stderr, output } = await run("https://broker.example.test:8443", { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl }, { sandboxed: false });
    // The recording proxy is not the broker, so TLS cannot complete.
    expect(stderr).toContain("broker_transport_unavailable");
    expect(output.token).toBeNull();
    expect(proxy.seen).toHaveLength(1);
    expect(proxy.seen[0]).toMatchObject({ method: "CONNECT", target: "broker.example.test:8443" });
    const tunneled = proxy.seen[0].bytes;
    expect(tunneled[0]).toBe(0x16); // TLS handshake record, not a plaintext request
    expect(tunneled.includes("broker.example.test")).toBe(true); // SNI names the broker
    for (const secret of [...secrets, "credentials"]) expect(tunneled.includes(secret)).toBe(false);
  });

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
    await expect(git("var", "GIT_AUTHOR_IDENT")).rejects.toThrow();
    expect(await git("status", "--porcelain")).toBe(""); // unrelated public/local Git still works
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_AUTHOR_NAME).toBe("");
  });
});
