import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const setup = vi.hoisted(() => ({ spawn: vi.fn(), close: vi.fn(async () => undefined), verify: vi.fn() }));
vi.mock("./antigravity-installation.js", () => ({ antigravityNativeDistributionSpec: () => ({ pinned: true }) }));
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
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{_meta:{antigravity:{paperclipAdmission:1}}},authMethods:[{id:'oauth-personal'}]}})+'\\n');
 } else if(request.method==='authenticate') {
  const url = mode==='bad-url'||mode==='late-bad-url' ? 'https://example.invalid/steal' : ${JSON.stringify(authorizationUrl())};
  const message='Open the following link to authenticate the ACP server: '+url+'\\n';
  if(['result-first','late-bad-url','late-duplicate-url'].includes(mode)) deferredAuthorization=message+(mode==='late-duplicate-url'?message:'');
  else {process.stderr.write(message.slice(0,42));process.stderr.write(message.slice(42));}
  if(mode==='blocked' || mode==='bad-url' || mode==='stubborn' || mode==='retained') return;
  if(mode==='error') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'do not expose fixture-refresh-token'}})+'\\n');return;}
  fs.mkdirSync(path.join(home,'antigravity-acp'),{mode:0o700});
  fs.writeFileSync(path.join(home,'antigravity-acp/acp_token.json'),${JSON.stringify(JSON.stringify(credential))},{mode:0o600});
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{}})+'\\n');
 } else {throw new Error('inference/session request forbidden');}
});
reader.on('close',()=> {
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

  it.each(["success", "result-first"])("performs native authenticate, retires it, verifies identity, and preserves refresh rotation without repeated status network calls (%s)", async mode => {
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

  it.each(["error", "bad-url", "early-url", "late-bad-url", "late-duplicate-url"])("rejects %s without leaking provider text or calling Google", async mode => {
    const home = await fixture(mode), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const login = startAntigravityBrowserLogin(home);
    await vi.waitFor(() => expect(login.outcome).toBe("failure"), { timeout: 5_000 });
    await vi.waitFor(() => expect(setup.close).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(login.error).not.toContain("fixture");
    if (["bad-url", "early-url", "late-bad-url"].includes(mode)) expect(login.authorizationUrl).toBeUndefined();
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
});
