import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({ verify: vi.fn(), spawn: vi.fn(), close: vi.fn(), retire: vi.fn() }));
vi.mock("./antigravity-installation.js", () => ({ antigravityNativeDistributionSpec: () => ({ pinned: true }) }));
vi.mock("./installation-integrity.js", () => ({ verifyNativeAcpxInstallation: setup.verify }));
vi.mock("./antigravity-process.js", async importOriginal => ({
  ...await importOriginal<typeof import("./antigravity-process.js")>(), retireAntigravityProcess: setup.retire,
}));
import { startAntigravityBrowserLogin } from "./antigravity-auth.js";

const clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const scopes = ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"];
const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: clientId, response_type: "code",
  redirect_uri: "http://127.0.0.1:18973/", scope: scopes.join(" "), state: "fixture_state_0123456789", code_challenge: "a".repeat(43),
  code_challenge_method: "S256", access_type: "offline", prompt: "consent" });
const roots: string[] = [];
const physicalChildren: ChildProcess[] = [];
afterEach(async () => {
  for (const child of physicalChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid!, "SIGKILL"); } catch {}
    }
  }
  vi.unstubAllGlobals(); vi.clearAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

type Mode = "url-first" | "result-first" | "wrong-url" | "duplicate-url" | "unexpected-prompt" | "retirement-failure" | "credential-failure" | "auth-error" | "late-wrong-url" | "late-duplicate-url";
async function fixture(mode: Mode) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-stream-test-"))); roots.push(home);
  await mkdir(join(home, "antigravity-acp"), { mode: 0o700 });
  await writeFile(join(home, "antigravity-acp/acp_token.json"), JSON.stringify({ client_id: clientId, client_secret: "synthetic-client-secret",
    refresh_token: "synthetic-refresh-token", token_uri: "https://oauth2.googleapis.com/token", scopes }), { mode: 0o600 });
  const stdout = new PassThrough(), stderr = new PassThrough(), requests: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin: new Writable({ write(chunk, _encoding, done) {
    const request = JSON.parse(String(chunk)); requests.push(request.method);
    queueMicrotask(() => {
      if (request.method === "initialize") {
        stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: "1.4.3" }, agentCapabilities: { _meta: { antigravity: { paperclipAdmission: 1 } } },
          authMethods: [{ id: "oauth-personal" }] } }) + "\n");
      } else if (request.method === "authenticate") {
        const url = mode === "wrong-url" || mode === "late-wrong-url" ? "https://example.invalid/synthetic-private-marker" : authorizationUrl;
        const emitUrl = () => stderr.write("Open the following link to authenticate the ACP server: " + url + "\n");
        const resultFirst = ["result-first", "late-wrong-url", "late-duplicate-url"].includes(mode);
        if (!resultFirst) emitUrl();
        if (mode === "duplicate-url") emitUrl();
        if (mode === "unexpected-prompt") stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: {} }) + "\n");
        stdout.write(JSON.stringify(mode === "auth-error"
          ? { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "synthetic-private-marker" } }
          : { jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
        if (resultFirst) queueMicrotask(() => { emitUrl(); if (mode === "late-duplicate-url") emitUrl(); });
      } else throw new Error("Unexpected session/model request");
    });
    done();
  } }) });
  setup.close.mockResolvedValue(undefined);
  setup.retire.mockImplementation(async (_child, closed: Promise<void>) => {
    await Promise.resolve(); child.emit("close", 0); await closed;
  });
  if (mode === "retirement-failure") setup.retire.mockImplementationOnce(async () => { throw new Error("synthetic-private-marker"); });
  setup.spawn.mockReturnValue(child);
  setup.verify.mockResolvedValue({ openCommand: async () => ({ spawn: setup.spawn, close: setup.close }) });
  const fetch = vi.fn(async (url: string) => {
    if (mode === "credential-failure") return new Response(null, { status: 401 });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic-access-token", token_type: "Bearer" });
    if (url === "https://www.googleapis.com/oauth2/v3/userinfo") return Response.json({ email: "person@example.test", email_verified: true });
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", fetch);
  return { home, requests, fetch };
}

describe("Antigravity login cross-stream completion", () => {
  it.each(["url-first", "result-first"] as const)("accepts the same authenticated exchange with %s delivery", async mode => {
    const { home, requests, fetch } = await fixture(mode);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBeDefined());
    expect(login.outcome).toBe("success");
    expect(login.authorizationUrl).toBe(authorizationUrl);
    expect(requests).toEqual(["initialize", "authenticate"]);
    expect(setup.retire).toHaveBeenCalledOnce(); expect(setup.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    await login.abort();
  });

  it.each(["wrong-url", "duplicate-url", "unexpected-prompt", "retirement-failure", "credential-failure", "auth-error", "late-wrong-url", "late-duplicate-url"] as const)("keeps %s failures closed and private", async mode => {
    const { home, requests, fetch } = await fixture(mode);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBeDefined());
    expect(login.outcome).toBe("failure"); expect(login.error).toBe("Google sign-in did not complete. Start sign-in again.");
    expect(login.error).not.toContain("synthetic-private-marker");
    await login.abort(); expect(setup.close).toHaveBeenCalledOnce();
    expect(requests).toEqual(["initialize", "authenticate"]);
    expect(fetch).toHaveBeenCalledTimes(mode === "credential-failure" ? 1 : 0);
    if (mode === "wrong-url" || mode === "late-wrong-url") expect(login.authorizationUrl).toBeUndefined();
  });

  it.each(["valid", "invalid", "duplicate"] as const)("handles a %s URL from a real child after authenticate completion and stdin EOF", async mode => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-real-stream-"))); roots.push(home);
    const peer = join(home, "peer.cjs");
    await writeFile(peer, `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.argv[2], mode = process.argv[3], requests = [], events = [];
const reader = readline.createInterface({input:process.stdin});
reader.on('line', line => {
 const request = JSON.parse(line); requests.push(request.method);
 fs.writeFileSync(path.join(home,'requests.json'),JSON.stringify(requests));
 if(request.method==='initialize') {
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,
   agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{_meta:{antigravity:{paperclipAdmission:1}}},
   authMethods:[{id:'oauth-personal'}]}})+'\\n');
 } else if(request.method==='authenticate') {
  fs.mkdirSync(path.join(home,'antigravity-acp'),{mode:0o700});
  fs.writeFileSync(path.join(home,'antigravity-acp/acp_token.json'),${JSON.stringify(JSON.stringify({ client_id: clientId,
      client_secret: "synthetic-client-secret", refresh_token: "synthetic-refresh-token", token_uri: "https://oauth2.googleapis.com/token", scopes }))},{mode:0o600});
  events.push('authenticate-result');
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
 } else throw new Error('Unexpected session/model request');
});
reader.on('close',()=>{
 events.push('stdin-eof');
 const url = mode==='invalid' ? 'https://example.invalid/synthetic-private-marker' : ${JSON.stringify(authorizationUrl)};
 const message = 'Open the following link to authenticate the ACP server: '+url+'\\n';
 process.stderr.write(mode==='duplicate' ? message+message : message,()=>{
  events.push('url-flushed');fs.writeFileSync(path.join(home,'events.json'),JSON.stringify(events));process.exit(0);
 });
});
`);
    setup.spawn.mockImplementation((_args, options) => {
      const child = spawn(process.execPath, [peer, home, mode], { ...options, detached: true });
      physicalChildren.push(child); return child;
    });
    setup.close.mockResolvedValue(undefined);
    setup.verify.mockResolvedValue({ openCommand: async () => ({ spawn: setup.spawn, close: setup.close }) });
    const realProcess = await vi.importActual<typeof import("./antigravity-process.js")>("./antigravity-process.js");
    setup.retire.mockImplementation(realProcess.retireAntigravityProcess);
    const fetch = vi.fn(async (url: string) => {
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "synthetic-access-token",
        refresh_token: "synthetic-rotated-refresh", token_type: "Bearer" });
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo") return Response.json({ email: "person@example.test", email_verified: true });
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBeDefined(), { timeout: 5_000 });
    expect(login.outcome).toBe(mode === "valid" ? "success" : "failure");
    expect(JSON.parse(await readFile(join(home, "events.json"), "utf8"))).toEqual(["authenticate-result", "stdin-eof", "url-flushed"]);
    expect(JSON.parse(await readFile(join(home, "requests.json"), "utf8"))).toEqual(["initialize", "authenticate"]);
    expect(physicalChildren.at(-1)!.exitCode).toBe(0);
    expect(setup.retire).toHaveBeenCalledOnce(); expect(setup.close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(mode === "valid" ? 2 : 0);
    if (mode === "valid") {
      expect(login.authorizationUrl).toBe(authorizationUrl);
      expect(JSON.parse(await readFile(join(home, "antigravity-acp", "acp_token.json"), "utf8")).refresh_token).toBe("synthetic-rotated-refresh");
    } else {
      expect(login.error).toBe("Google sign-in did not complete. Start sign-in again.");
      expect(login.error).not.toContain("synthetic-private-marker");
      if (mode === "invalid") expect(login.authorizationUrl).toBeUndefined();
    }
    await login.abort();
    expect(setup.close).toHaveBeenCalledOnce();
  }, 15_000);
});
