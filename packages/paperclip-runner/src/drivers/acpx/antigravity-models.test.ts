import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexAcpxDriver } from "./codex-acpx-driver.js";
import { acpxCapabilities, acpxDriverDescriptor, validateAcpxDriverConfig } from "./driver-profile.js";
import { verifyQualifiedAcpxInstallation } from "./installation-integrity.js";
import { verifyAcpxProfileInstallation } from "./profile-installation.js";
import { assertAcpxProfileReleased, resolveQualifiedAcpxProfile } from "./qualified-profiles.js";

const setup = vi.hoisted(() => ({ spawn: vi.fn(), close: vi.fn(async () => undefined), verify: vi.fn(), uncertainRetirement: false }));
vi.mock("./antigravity-installation.js", () => ({ antigravityNativeDistributionSpec: () => ({ pinned: true }) }));
vi.mock("./installation-integrity.js", async original => ({
  ...await original<typeof import("./installation-integrity.js")>(), verifyNativeAcpxInstallation: setup.verify,
}));
vi.mock("./antigravity-process.js", async original => {
  const actual = await original<typeof import("./antigravity-process.js")>();
  return { ...actual, retireAntigravityProcess: (...args: Parameters<typeof actual.retireAntigravityProcess>) => setup.uncertainRetirement
    ? Promise.reject(new Error("controlled retirement uncertainty")) : actual.retireAntigravityProcess(...args) };
});
import { AntigravityModelDiscoveryCleanupError, discoverAntigravityModels } from "./antigravity-models.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  setup.uncertainRetirement = false;
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

async function fixture(mode = "success") {
  const home = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-models-test-"))); roots.push(home);
  const peer = join(home, "peer.cjs");
  await writeFile(peer, `
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const home=process.argv[2],mode=process.argv[3],requests=[];
if(mode==='stubborn') {
 process.on('SIGTERM',()=>{});
 const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
 fs.writeFileSync(path.join(home,'descendant.pid'),String(child.pid));
}
const reader=readline.createInterface({input:process.stdin});
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
reader.on('line',line=>{
 const request=JSON.parse(line);requests.push(request);fs.writeFileSync(path.join(home,'requests.json'),JSON.stringify(requests));
 if(request.method==='initialize') {
  reply(request.id,{protocolVersion:1,agentInfo:{name:'antigravity-acp',version:'1.4.3'},agentCapabilities:{_meta:{antigravity:{paperclipAdmission:1,paperclipModels:mode==='old-patch'?0:1}}},authMethods:[{id:'oauth-personal'}]});
 } else if(request.method==='_paperclip/models') {
  if(mode==='blocked'||mode==='stubborn') return;
  if(mode==='error') {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'private-token-do-not-expose'}})+'\\n');return;}
  if(mode==='bad-utf8') {process.stdout.write(Buffer.from([255,10]));return;}
  if(mode==='overflow') {process.stdout.write('x'.repeat(1048577));return;}
  const result={schema:request.params.schema,nonce:request.params.nonce,authMethod:'oauth-personal',models:[{id:'gemini-pro-agent',label:'Gemini Pro (High)'},{id:'gemini-3.1-pro-low',label:'Gemini Pro (Low)'}],defaultModelId:'gemini-pro-agent',ignoredPrivateData:'private-token-do-not-expose'};
  if(mode==='wrong-nonce') result.nonce='stale-nonce';
  if(mode==='wrong-auth') result.authMethod='gemini-api-key';
  if(mode==='wrong-schema') result.schema='another-schema';
  if(mode==='duplicate') result.models.push(result.models[0]);
  if(mode==='unknown-default') result.defaultModelId='unavailable-model';
  if(mode==='bad-label') result.models[0].label='bad\\u0000label';
  if(mode==='auto-model') result.models[0].id='auto';
  if(mode==='many-models') result.models=Array.from({length:201},(_,i)=>({id:'gemini-'+i,label:'Gemini '+i}));
  reply(mode==='wrong-id'?91:request.id,result);
 } else throw new Error('setup sent forbidden authentication/session/prompt method');
});
reader.on('close',()=>mode==='stubborn'||mode==='blocked'?setInterval(()=>{},1000):process.exit(0));
`);
  setup.verify.mockResolvedValue({ openCommand: async () => ({ spawn: setup.spawn, close: setup.close }) });
  setup.spawn.mockImplementation((_args, options) => {
    const child = spawn(process.execPath, [peer, home, mode], { ...options, detached: true }); children.push(child); return child;
  });
  return home;
}

describe("Antigravity session-free account model discovery", () => {
  it("returns only nonce-bound account models after process retirement with no ambient auth or direct account requests", async () => {
    const home = await fixture(), fetch = vi.fn(() => { throw new Error("direct account requests forbidden"); }); vi.stubGlobal("fetch", fetch);
    const result = await discoverAntigravityModels(home);
    expect(result).toEqual({ models: [{ id: "gemini-pro-agent", label: "Gemini Pro (High)" }, { id: "gemini-3.1-pro-low", label: "Gemini Pro (Low)" }], defaultModelId: "gemini-pro-agent" });
    const requests = JSON.parse(await readFile(join(home, "requests.json"), "utf8"));
    expect(requests.map((value: { method: string }) => value.method)).toEqual(["initialize", "_paperclip/models"]);
    expect(requests[1].params).toEqual({ schema: "paperclip.antigravity.models.v1", nonce: expect.any(String), authMethod: "oauth-personal" });
    expect(setup.spawn.mock.calls[0]![1]).toMatchObject({ detached: true, env: { GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: "/usr/bin/true" } });
    expect(Object.keys(setup.spawn.mock.calls[0]![1].env).some(key => /^(?:GOOGLE_|GEMINI_API|ANTIGRAVITY_|PYTHON|NODE_OPTIONS|HTTP_PROXY)/.test(key))).toBe(false);
    expect(children[0]!.exitCode).toBe(0); expect(setup.close).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["old-patch", "wrong-nonce", "wrong-auth", "wrong-schema", "wrong-id", "duplicate", "unknown-default", "bad-label", "auto-model", "many-models", "bad-utf8", "overflow", "error"])("rejects %s and retires the process without exposing native text", async mode => {
    const home = await fixture(mode);
    await expect(discoverAntigravityModels(home)).rejects.toThrow("Could not load models for this Google account");
    expect(children[0]!.exitCode).toBe(0); expect(setup.close).toHaveBeenCalledOnce();
    if (mode === "old-patch") expect(JSON.parse(await readFile(join(home, "requests.json"), "utf8"))).toHaveLength(1);
  });

  it("cancellation retires a blocked catalog process and inherited descendant before rejecting", async () => {
    const home = await fixture("stubborn"), controller = new AbortController();
    const result = discoverAntigravityModels(home, { signal: controller.signal });
    void result.catch(() => undefined);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(home, "requests.json"), "utf8"))).toHaveLength(2));
    const descendant = (await readFile(join(home, "descendant.pid"), "utf8")).trim();
    controller.abort();
    await expect(result).rejects.toThrow("Could not load models for this Google account");
    expect(children[0]!.signalCode).toBe("SIGKILL"); expect(setup.close).toHaveBeenCalledOnce();
    let state = "";
    try { state = execFileSync("/bin/ps", ["-o", "stat=", "-p", descendant], { encoding: "utf8" }).trim(); } catch {}
    expect(state === "" || state.startsWith("Z")).toBe(true);
  });

  it("retains the actual child, lease and caller home through cleanup uncertainty, then releases exactly once after physical exit", async () => {
    const home = await fixture("error"); setup.uncertainRetirement = true;
    const error = await discoverAntigravityModels(home).catch(error => error);
    expect(error).toBeInstanceOf(AntigravityModelDiscoveryCleanupError);
    expect(error.operationError.message).toContain("Could not load models");
    expect(error.cleanupError.message).toBe("controlled retirement uncertainty");
    expect(error.message).not.toContain("private-token");
    expect(children[0]!.exitCode).toBeNull(); expect(children[0]!.signalCode).toBeNull();
    expect(setup.close).not.toHaveBeenCalled();
    const releaseHome = vi.fn(() => rm(home, { recursive: true, force: true }));
    const cleaned = error.retired.then(releaseHome);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(releaseHome).not.toHaveBeenCalled(); await expect(access(home)).resolves.toBeUndefined();
    setup.uncertainRetirement = false;
    process.kill(-children[0]!.pid!, "SIGTERM");
    await cleaned;
    expect(setup.close).toHaveBeenCalledOnce(); expect(releaseHome).toHaveBeenCalledOnce();
    expect(children[0]!.signalCode).toBe("SIGTERM");
    await expect(access(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces its real 30-second overall deadline and physically retires a blocked metadata call", async () => {
    const home = await fixture("blocked"), start = Date.now();
    await expect(discoverAntigravityModels(home)).rejects.toThrow("Could not load models for this Google account");
    expect(Date.now() - start).toBeGreaterThanOrEqual(29_500);
    expect(Date.now() - start).toBeLessThan(35_000);
    expect(children[0]!.signalCode).toBe("SIGTERM"); expect(setup.close).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(join(home, "requests.json"), "utf8")).map((value: { method: string }) => value.method)).toEqual(["initialize", "_paperclip/models"]);
  }, 40_000);
});

describe("Antigravity pending release boundaries", () => {
  it("retains release admission for existing providers, including Copilot's separate capability status", () => {
    for (const agent of ["claude", "codex", "grok", "cursor", "pi", "copilot"] as const) {
      expect(() => assertAcpxProfileReleased(agent)).not.toThrow();
    }
    expect(acpxCapabilities("copilot")).toMatchObject({ typedEvents: true, dynamicTools: true });
  });

  it("preserves the caller's exact model separately from release admission", () => {
    expect(resolveQualifiedAcpxProfile("antigravity", "caller-exact-model")).toMatchObject({
      agent: "antigravity", qualificationStatus: "pending", qualificationModel: "caller-exact-model", reportedModelId: "caller-exact-model",
    });
    expect(validateAcpxDriverConfig({ agent: "antigravity", model: "caller-exact-model" }))
      .toMatchObject({ ok: false, issues: [{ path: "agent", code: "qualification_pending" }] });
    expect(() => assertAcpxProfileReleased("antigravity")).toThrow(expect.objectContaining({ code: "ACPX_PROFILE_QUALIFICATION_PENDING" }));
  });

  it("advertises no accepted runtime or context capabilities", () => {
    expect(acpxDriverDescriptor("antigravity")).toMatchObject({ displayName: "Google Antigravity via ACPX",
      runtimeContextCapabilities: { instructions: "unsupported", skills: "unsupported", mcp: "unsupported" } });
    for (const value of Object.values(acpxCapabilities("antigravity"))) {
      if (typeof value === "boolean") expect(value).toBe(false);
    }
  });

  it("rejects direct construction before opening a runtime host", () => {
    const openHost = vi.fn();
    expect(() => new CodexAcpxDriver({ agent: "antigravity", model: "caller-exact-model", runtimeDirectory: "/unused",
      providerPolicy: { readOnly: false } }, { openHost }))
      .toThrow(expect.objectContaining({ code: "ACPX_PROFILE_QUALIFICATION_PENDING" }));
    expect(openHost).not.toHaveBeenCalled();
  });

  it("refuses raw installation lookup even after a caller strips the pending marker", async () => {
    const profile = { ...resolveQualifiedAcpxProfile("antigravity", "caller-exact-model"), qualificationStatus: undefined };
    const resolvePackage = vi.fn();
    await expect(verifyQualifiedAcpxInstallation(profile, resolvePackage))
      .rejects.toMatchObject({ code: "ACPX_PROFILE_QUALIFICATION_PENDING" });
    await expect(verifyAcpxProfileInstallation(profile))
      .rejects.toMatchObject({ code: "ACPX_PROFILE_QUALIFICATION_PENDING" });
    expect(resolvePackage).not.toHaveBeenCalled();
  });
});
