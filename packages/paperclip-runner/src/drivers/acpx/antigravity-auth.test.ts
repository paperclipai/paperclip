import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({ spawn: vi.fn(), close: vi.fn(async () => undefined), verify: vi.fn(), spec: vi.fn((..._args: unknown[]) => ({ pinned: true })) }));
vi.mock("./antigravity-installation.js", () => ({ antigravityNativeDistributionSpec: setup.spec }));
vi.mock("./installation-integrity.js", () => ({ verifyNativeAcpxInstallation: setup.verify }));
import { sanitizeAntigravityCredential, startAntigravityBrowserLogin, validateAntigravityAuthorizationUrl, verifyAntigravityCredential } from "./antigravity-auth.js";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const credential = { client_id: CLIENT_ID, client_secret: "fixture-client-secret", refresh_token: "fixture-refresh-token", token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"], project_id: "fixture-project" };
function authorizationUrl() {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({ client_id: CLIENT_ID, response_type: "code", redirect_uri: "http://127.0.0.1:18973/",
    scope: credential.scopes.join(" "), state: "fixture_state_0123456789", code_challenge: "a".repeat(43), code_challenge_method: "S256", access_type: "offline", prompt: "consent" });
}
const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

async function fixture(mode = "success") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-login-test-"))); roots.push(home);
  const peer = join(home, "peer.cjs");
  await writeFile(peer, `
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const home = process.argv[2], mode = process.argv[3];
const requests = [];
let deferredAuthorization = '';
if(mode==='stubborn') {
 process.on('SIGTERM',()=>{});
 const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
 fs.writeFileSync(path.join(home,'descendant.pid'),String(child.pid));
}
const reader = readline.createInterface({input:process.stdin});
reader.on('line', line => {
 const request=JSON.parse(line); requests.push(request);
 fs.writeFileSync(path.join(home,'requests.json'),JSON.stringify(requests));
 if(request.method==='initialize') {
  if(mode==='early-url') { process.stderr.write('Open the following link to authenticate the ACP server: '+${JSON.stringify(authorizationUrl())}+'\\n'); return; }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.5.2'},agentCapabilities:{_meta:{antigravity:{paperclipAdmission:1}}},authMethods:[{id:'oauth-personal'}]}})+'\\n');
 } else if(request.method==='authenticate') {
  const url = mode.startsWith('bad-url')||mode==='late-bad-url' ? 'https://example.invalid/steal' : ${JSON.stringify(authorizationUrl())};
  const message='Open the following link to authenticate the ACP server: '+url+'\\n';
  if(['result-first','late-bad-url','late-duplicate-url'].includes(mode)||mode.endsWith('url-after-result')) deferredAuthorization=message+(mode==='late-duplicate-url'?message:'');
  else {process.stderr.write(message.slice(0,42));process.stderr.write(message.slice(42));}
  if(mode==='blocked' || mode==='bad-url' || mode==='stubborn' || mode==='retained') return;
  if(mode==='error') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'do not expose fixture-refresh-token'}})+'\\n');return;}
  fs.mkdirSync(path.join(home,'antigravity-acp'),{mode:0o700});
  fs.writeFileSync(path.join(home,'antigravity-acp/acp_token.json'),${JSON.stringify(JSON.stringify(credential))},{mode:0o600});
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
 } else {throw new Error('inference/session request forbidden');}
});
reader.on('close',()=> {
 // EOF proves the client received the authenticate result before this stderr.
 if(deferredAuthorization) process.stderr.write(deferredAuthorization,()=>process.exit(0));
 else if(mode==='stubborn'||mode==='retained') setInterval(()=>{},1000);
 else process.exit(0);
});
`);
  setup.verify.mockResolvedValue({ openCommand: async () => ({ spawn: setup.spawn, close: setup.close }) });
  setup.spawn.mockImplementation((_args, options) => {
    const child = spawn(process.execPath, [peer, home, mode], { ...options, detached: true }); children.push(child); return child;
  });
  return home;
}

function googleIdentity(emailVerified = true) {
  return vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    if (url === "https://oauth2.googleapis.com/token") {
      expect(options.redirect).toBe("error");
      expect(String(options.body)).toContain("grant_type=refresh_token");
      return new Response(JSON.stringify({ access_token: "fixture-access-token", refresh_token: "fixture-rotated-refresh", token_type: "Bearer" }));
    }
    expect(url).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
    expect(options.headers).toEqual({ Authorization: "Bearer fixture-access-token" });
    return new Response(JSON.stringify({ email: "person@example.test", email_verified: emailVerified }));
  });
}

describe("Antigravity setup-only Google authentication", () => {
  it.each(["network", "unverified"])("preserves an OAuth rotation when userinfo %s verification fails", async failure => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-rotation-test-"))); roots.push(home);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "antigravity-acp"), { mode: 0o700 });
    const token = join(home, "antigravity-acp", "acp_token.json");
    await writeFile(token, JSON.stringify(credential), { mode: 0o600 });
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ access_token: "fixture-access-token", refresh_token: "fixture-newest-rotation", token_type: "Bearer" }));
    if (failure === "network") fetch.mockRejectedValueOnce(new Error("fixture userinfo unavailable"));
    else fetch.mockResolvedValueOnce(Response.json({ email: "person@example.test", email_verified: false }));
    vi.stubGlobal("fetch", fetch);
    await expect(verifyAntigravityCredential(home)).rejects.toThrow();
    expect(JSON.parse(await readFile(token, "utf8")).refresh_token).toBe("fixture-newest-rotation");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  // The login predicate keeps its five-second bound. Allow ten more seconds
  // for fixture startup and the durable mocked credential checks on a busy CI worker.
  it.each(["success", "result-first", "url-after-result"])("performs native authenticate, retires it, verifies identity, and preserves refresh rotation without repeated status network calls (%s)", async mode => {
    const home = await fixture(mode), fetch = googleIdentity(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBeDefined(), { timeout: 5_000 });
    expect(login.outcome).toBe("success");
    expect(login.authorizationUrl).toBe(authorizationUrl());
    expect(JSON.parse(await readFile(join(home, "requests.json"), "utf8")).map((request: { method: string }) => request.method)).toEqual(["initialize", "authenticate"]);
    expect(setup.spawn.mock.calls[0]![1].env).toMatchObject({ GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: "/usr/bin/true" });
    expect(Object.keys(setup.spawn.mock.calls[0]![1].env).some(key => /^(?:GOOGLE_|GEMINI_API|ANTIGRAVITY_|PYTHON|NODE_OPTIONS|HTTP_PROXY)/.test(key))).toBe(false);
    expect(setup.close).toHaveBeenCalledOnce();
    expect(children[0]!.exitCode).toBe(0);
    const verified = await verifyAntigravityCredential(home);
    expect(verified.accountEmail).toBe("person@example.test");
    expect(JSON.parse(verified.credential).refresh_token).toBe("fixture-rotated-refresh");
    expect(JSON.parse(await readFile(join(home, "antigravity-acp/acp_token.json"), "utf8")).refresh_token).toBe("fixture-rotated-refresh");
    expect(fetch).toHaveBeenCalledTimes(2);
    await login.abort();
    // Runtime verification outside a live browser attempt must not retain a
    // credential indefinitely in the browser status cache.
    await verifyAntigravityCredential(home);
    await verifyAntigravityCredential(home);
    expect(fetch).toHaveBeenCalledTimes(6);
  }, 15_000);

  it.each(["error", "bad-url", "early-url", "late-bad-url", "late-duplicate-url", "bad-url-after-result"])("rejects %s without leaking provider text or calling Google", async mode => {
    const home = await fixture(mode), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await vi.waitFor(() => expect(setup.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(login.error).not.toContain("fixture");
    if (mode.startsWith("bad-url") || ["early-url", "late-bad-url"].includes(mode)) expect(login.authorizationUrl).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("abort retires a waiting native flow without session requests", async () => {
    const home = await fixture("blocked"), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    login.abort();
    await vi.waitFor(() => expect(setup.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(login.outcome).toBe("failure"); expect(fetch).not.toHaveBeenCalled();
    expect(children[0]!.exitCode).toBe(0);
  });

  it("abort waits for SIGKILL retirement of a login and inherited descendant that ignore EOF and SIGTERM", async () => {
    const home = await fixture("stubborn"); vi.stubGlobal("fetch", vi.fn());
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    const descendant = (await readFile(join(home, "descendant.pid"), "utf8")).trim();
    await login.abort();
    expect(children[0]!.signalCode).toBe("SIGKILL");
    expect(setup.close).toHaveBeenCalledOnce();
    let state = "";
    try { state = execFileSync("/bin/ps", ["-o", "stat=", "-p", descendant], { encoding: "utf8" }).trim(); } catch {}
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("keeps abort, the command lease and the private home owned through uncertain retirement until the actual child exits", async () => {
    const home = await fixture("retained"); vi.stubGlobal("fetch", vi.fn());
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    const child = children[0]!, realKill = process.kill.bind(process);
    let blockProof = true;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (blockProof && pid === -child.pid! && signal === 0) throw Object.assign(new Error("controlled process-state uncertainty"), { code: "EACCES" });
      return realKill(pid, signal);
    });
    const stopped = login.abort(), releaseHome = vi.fn(() => rm(home, { recursive: true, force: true }));
    const cleaned = stopped.then(releaseHome);
    await vi.waitFor(() => expect(login.error).toContain("still stopping"), { timeout: 5_000 });
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
    expect(setup.close).not.toHaveBeenCalled(); expect(releaseHome).not.toHaveBeenCalled();
    await expect(access(home)).resolves.toBeUndefined();
    blockProof = false;
    realKill(-child.pid!, "SIGKILL");
    await cleaned;
    expect(child.signalCode).toBe("SIGKILL");
    expect(setup.close).toHaveBeenCalledOnce(); expect(releaseHome).toHaveBeenCalledOnce();
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not accept an unverified Google account after native authentication", async () => {
    const home = await fixture(); vi.stubGlobal("fetch", googleIdentity(false));
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    expect(setup.close).toHaveBeenCalledOnce();
  });

  it("reports a missing server runtime plainly instead of an unfinished sign-in", async () => {
    const home = await fixture(); const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    setup.verify.mockRejectedValueOnce(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" }));
    const onFailure = vi.fn();
    const login = startAntigravityBrowserLogin(home, { onFailure });
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("runtime_unavailable");
    expect(login.error).toBe("This server does not have the current Google Antigravity runtime, so Google sign-in cannot start. Use a Google API key instead, or update Paperclip on this server.");
    expect(login.authorizationUrl).toBeUndefined();
    expect(setup.spawn).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a runtime that exits before showing a sign-in link as a failed start", async () => {
    const home = await fixture(); vi.stubGlobal("fetch", vi.fn());
    setup.spawn.mockImplementationOnce((_args, options) => {
      const child = spawn(process.execPath, ["-e", "process.exit(1)"], { ...options, detached: true }); children.push(child); return child;
    });
    const onFailure = vi.fn();
    const login = startAntigravityBrowserLogin(home, { onFailure });
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await vi.waitFor(() => expect(setup.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(login.error).toBe("Google sign-in could not start on this server. Start sign-in again.");
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("start_failed");
    expect(login.authorizationUrl).toBeUndefined();
  });

  it("reports a resolver failure as an unavailable runtime", async () => {
    const home = await fixture(); vi.stubGlobal("fetch", vi.fn());
    setup.spec.mockImplementationOnce(() => { throw new Error("Antigravity has no admitted complete runtime closure for fixture"); });
    const onFailure = vi.fn();
    const login = startAntigravityBrowserLogin(home, { onFailure });
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("runtime_unavailable");
    expect(login.error).toContain("does not have the current Google Antigravity runtime");
    expect(login.error).not.toContain("Start sign-in again");
  });

  it("reports a failure after the runtime starts as an incomplete sign-in", async () => {
    const home = await fixture("error"); vi.stubGlobal("fetch", vi.fn());
    const onFailure = vi.fn();
    const login = startAntigravityBrowserLogin(home, { onFailure });
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("login_incomplete");
    expect(login.error).toBe("Google sign-in did not complete. Start sign-in again.");
  });

  it("reports a cancelled attempt as aborted", async () => {
    const home = await fixture("blocked"); vi.stubGlobal("fetch", vi.fn());
    const onFailure = vi.fn();
    const login = startAntigravityBrowserLogin(home, { onFailure });
    await vi.waitFor(() => expect(login.authorizationUrl).toBeDefined());
    await login.abort();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith("aborted");
    expect(login.outcome).toBe("failure");
  });

  it("requires the pinned OAuth client and token destination and strips unrelated native fields", () => {
    expect(JSON.parse(sanitizeAntigravityCredential(JSON.stringify({ ...credential, endpoint: "https://example.invalid", access_token: "discard" })))).toEqual(credential);
    expect(sanitizeAntigravityCredential(JSON.stringify({ ...credential, scopes: [...credential.scopes].reverse() }))).toBe(sanitizeAntigravityCredential(JSON.stringify(credential)));
    expect(() => sanitizeAntigravityCredential(JSON.stringify({ ...credential, token_uri: "https://example.invalid/token" }))).toThrow("Invalid Antigravity credential");
    expect(() => sanitizeAntigravityCredential(JSON.stringify({ ...credential, client_id: "another-client" }))).toThrow("Invalid Antigravity credential");
    expect(() => sanitizeAntigravityCredential(JSON.stringify({ ...credential, scopes: ["openid"] }))).toThrow("Invalid Antigravity credential");
  });

  it("requires Google PKCE and a numeric loopback redirect", () => {
    expect(validateAntigravityAuthorizationUrl(authorizationUrl())).toBe(authorizationUrl());
    for (const url of [authorizationUrl().replace("accounts.google.com", "example.invalid"), authorizationUrl().replace("S256", "plain"), authorizationUrl().replace("127.0.0.1", "localhost"), authorizationUrl() + "&state=duplicate"]) {
      expect(() => validateAntigravityAuthorizationUrl(url)).toThrow();
    }
  });

  async function loopbackFixture(responseStatus = 200) {
    const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-loopback-test-"))); roots.push(home);
    const peer = join(home, "loopback-peer.cjs");
    await writeFile(peer, `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const home = process.argv[2];
const statusCode = Number(process.argv[3] || 200);
const received = [];
const state = 'loopback_state_0123456789_' + Math.random().toString(36).slice(2, 10);
let server;
const reader = readline.createInterface({ input: process.stdin });
reader.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.5.2' }, agentCapabilities: { _meta: { antigravity: { paperclipAdmission: 1 } } }, authMethods: [{ id: 'oauth-personal' }] },
    }) + '\\n');
  } else if (request.method === 'authenticate') {
    server = http.createServer((req, res) => {
      received.push({ method: req.method, url: req.url });
      fs.writeFileSync(path.join(home, 'loopback-requests.json'), JSON.stringify(received));
      res.statusCode = statusCode;
      res.setHeader('Content-Type', 'text/plain');
      res.end(statusCode === 200 ? 'Authentication complete.' : 'sensitive-loopback-error-body');
      if (statusCode === 200) {
        server.close(() => {
          fs.mkdirSync(path.join(home, 'antigravity-acp'), { mode: 0o700 });
          fs.writeFileSync(path.join(home, 'antigravity-acp/acp_token.json'), ${JSON.stringify(JSON.stringify(credential))}, { mode: 0o600 });
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
        });
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const params = new URLSearchParams({
        client_id: ${JSON.stringify(CLIENT_ID)},
        response_type: 'code',
        redirect_uri: 'http://127.0.0.1:' + port + '/',
        scope: ${JSON.stringify(credential.scopes.join(" "))},
        state,
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      });
      process.stderr.write('Open the following link to authenticate the ACP server: https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() + '\\n');
    });
  }
});
reader.on('close', () => {
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
});
`);
    setup.verify.mockResolvedValue({ openCommand: async () => ({ spawn: setup.spawn, close: setup.close }) });
    setup.spawn.mockImplementation((_args, options) => {
      const child = spawn(process.execPath, [peer, home, String(responseStatus)], { ...options, detached: true }); children.push(child); return child;
    });
    return home;
  }

  function stubGoogleAllowLoopback() {
    const realFetch = globalThis.fetch;
    const googleFetch = googleIdentity();
    const wrapped = vi.fn().mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      return googleFetch(url, init ?? {});
    });
    vi.stubGlobal("fetch", wrapped);
    return { wrapped, googleFetch };
  }

  it("relays a validated loopback redirect URL to the local ACP listener and completes sign-in", async () => {
    const home = await loopbackFixture(200);
    const { wrapped } = stubGoogleAllowLoopback();
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.submitRedirect).toBeTypeOf("function"), { timeout: 5_000 });
    const parsedAuth = new URL(login.authorizationUrl!);
    const redirectUri = parsedAuth.searchParams.get("redirect_uri")!;
    const expectedState = parsedAuth.searchParams.get("state")!;
    const uniqueCode = `4/0valid-relay-code-${Date.now()}`;
    const pasted = `${redirectUri}?state=${encodeURIComponent(expectedState)}&code=${encodeURIComponent(uniqueCode)}&scope=email&extra=ignored`;

    await login.submitRedirect!(pasted);
    expect(login.submitRedirect).toBeUndefined();
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5_000 });
    const received = JSON.parse(await readFile(join(home, "loopback-requests.json"), "utf8")) as Array<{ method: string; url: string }>;
    expect(received).toEqual([{
      method: "GET",
      url: `/?state=${encodeURIComponent(expectedState)}&code=${encodeURIComponent(uniqueCode)}`,
    }]);
    expect(wrapped).toHaveBeenCalledWith(
      `${redirectUri}?state=${encodeURIComponent(expectedState)}&code=${encodeURIComponent(uniqueCode)}`,
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    await login.abort();
  });

  it("rejects bad redirect pastes without burning the loopback listener, and rejects reused codes and second submissions", async () => {
    const home = await loopbackFixture(200);
    stubGoogleAllowLoopback();
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.submitRedirect).toBeTypeOf("function"), { timeout: 5_000 });
    const parsedAuth = new URL(login.authorizationUrl!);
    const redirectUri = parsedAuth.searchParams.get("redirect_uri")!;
    const expectedState = parsedAuth.searchParams.get("state")!;
    const port = Number(new URL(redirectUri).port);

    // Wrong state, wrong port/host/protocol/pathname, duplicate params, error param, oversized, control chars.
    const invalidInputs = [
      `${redirectUri}?state=wrong_state_canary_999&code=secret-code-canary`,
      `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}/?state=${expectedState}&code=secret-code-canary`,
      `http://localhost:${port}/?state=${expectedState}&code=secret-code-canary`,
      `https://127.0.0.1:${port}/?state=${expectedState}&code=secret-code-canary`,
      `${redirectUri}callback?state=${expectedState}&code=secret-code-canary`,
      `http://user:pass@127.0.0.1:${port}/?state=${expectedState}&code=secret-code-canary`,
      `${redirectUri}?state=${expectedState}&code=secret-code-canary#frag`,
      `${redirectUri}?state=${expectedState}&state=${expectedState}&code=secret-code-canary`,
      `${redirectUri}?state=${expectedState}&code=a&code=b`,
      `${redirectUri}?error=access_denied&error_description=do-not-echo-canary&state=${expectedState}`,
      `${redirectUri}?state=${expectedState}&code=${"c".repeat(2049)}`,
      `${redirectUri}?state=${expectedState}&code=bad\ncode`,
      `${redirectUri}?state=${expectedState}&code=${"x".repeat(4097)}`,
    ];

    // Check first 4 invalid pastes stay retryable without touching the loopback server or leaking secrets.
    for (const bad of invalidInputs.slice(0, 4)) {
      const err = await login.submitRedirect!(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      if (!(err instanceof Error)) throw new Error("Expected redirect rejection");
      expect(err.message).not.toContain(expectedState);
      expect(err.message).not.toContain("secret-code-canary");
      expect(err.message).not.toContain("wrong_state_canary");
      expect(login.submitRedirect).toBeTypeOf("function");
    }
    await expect(access(join(home, "loopback-requests.json"))).rejects.toMatchObject({ code: "ENOENT" });

    // Valid paste still succeeds after 4 bad pastes.
    const usedCode = `4/0single-use-code-${Date.now()}`;
    const submitRef = login.submitRedirect!;
    await submitRef(`${redirectUri}?state=${expectedState}&code=${usedCode}`);
    // Second submission on the consumed handler is rejected immediately.
    await expect(submitRef(`${redirectUri}?state=${expectedState}&code=another-code`)).rejects.toThrow("can no longer accept");
    await vi.waitFor(() => expect(login.outcome).toBe("success"), { timeout: 5_000 });
    await login.abort();

    // Check remaining invalid shapes + reused code on a fresh attempt, plus the 5-attempt cap.
    const home2 = await loopbackFixture(200);
    stubGoogleAllowLoopback();
    const login2 = startAntigravityBrowserLogin(home2);
    await vi.waitFor(() => expect(login2.submitRedirect).toBeTypeOf("function"), { timeout: 5_000 });
    const parsedAuth2 = new URL(login2.authorizationUrl!);
    const redirectUri2 = parsedAuth2.searchParams.get("redirect_uri")!;
    const expectedState2 = parsedAuth2.searchParams.get("state")!;
    const port2 = Number(new URL(redirectUri2).port);
    for (const bad of [
      `${redirectUri2}?error=access_denied&error_description=do-not-echo-canary&state=${expectedState2}`,
      `${redirectUri2}?state=${expectedState2}&code=${usedCode}`,
      `${redirectUri2}?state=${expectedState2}&state=${expectedState2}&code=unique-1`,
      `http://user:pass@127.0.0.1:${port2}/?state=${expectedState2}&code=unique-2`,
    ]) {
      const err = await login2.submitRedirect!(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      if (!(err instanceof Error)) throw new Error("Expected redirect rejection");
      expect(err.message).not.toContain("do-not-echo-canary");
      expect(err.message).not.toContain(usedCode);
      expect(err.message).not.toContain(expectedState2);
    }
    // 5th bad paste terminates the attempt cleanly.
    await expect(login2.submitRedirect!(`${redirectUri2}?state=${expectedState2}&code=${"c".repeat(2049)}`)).rejects.toThrow("Too many invalid");
    expect(login2.submitRedirect).toBeUndefined();
    await vi.waitFor(() => expect(login2.outcome).toBe("failure"), { timeout: 5_000 });
    await expect(access(join(home2, "loopback-requests.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await login2.abort();
  });

  it("fails cleanly without leaking body when the loopback listener returns non-200", async () => {
    const home = await loopbackFixture(500);
    stubGoogleAllowLoopback();
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.submitRedirect).toBeTypeOf("function"), { timeout: 5_000 });
    const parsedAuth = new URL(login.authorizationUrl!);
    const redirectUri = parsedAuth.searchParams.get("redirect_uri")!;
    const expectedState = parsedAuth.searchParams.get("state")!;
    const err = await login.submitRedirect!(`${redirectUri}?state=${expectedState}&code=4/0non-200-code-${Date.now()}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    if (!(err instanceof Error)) throw new Error("Expected redirect rejection");
    expect(err.message).not.toContain("sensitive-loopback-error-body");
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await login.abort();
  });
});
