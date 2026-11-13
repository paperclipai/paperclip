import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { access, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QUALIFIED_ACPX_PROFILES } from "./acpx/qualified-profiles.js";
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./acpx/copilot-installation.js", () => ({ verifyCopilotInstallation: mocks.verify }));
import { createMetadataRpc, probeCopilotMetadata, validateCopilotMetadata } from "./copilot-metadata-probe.js";
function fakeChild(reply: (message: any) => unknown, closeOnEnd = true) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit("close", 0); return true; });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString());
    const response = reply(message);
    if (response !== undefined) queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response as object })}\n`)));
    done();
  }, final(done) { if (closeOnEnd) queueMicrotask(() => child.emit("close", 0)); done(); } });
  return child;
}
const verified = { status: "verified", version: "1.0.88", profileDigest: QUALIFIED_ACPX_PROFILES.copilot.commandDigest, models: [{ id: "gpt-5.6-luna", label: "GPT" }], promptSent: false };
beforeEach(() => vi.clearAllMocks());
describe("Copilot metadata boundary", () => {
  it("sends metadata only, binds an explicit token, and removes its private home", async () => {
    const methods: string[] = []; let environment: NodeJS.ProcessEnv = {}, cwd = "";
    const close = vi.fn(async () => {});
    const child = fakeChild(message => {
      methods.push(message.method);
      if (message.method === "initialize") return { result: { agentInfo: { version: "1.0.88" } } };
      if (message.method === "session/new") return { result: { sessionId: "session", models: { availableModels: [{ modelId: "gpt-5.6-luna", name: "GPT" }] } } };
      if (message.method === "session/set_config_option") return { result: { configOptions: [{ id: "model", currentValue: "gpt-5.6-luna" }] } };
      return { result: {} };
    });
    mocks.verify.mockResolvedValue({ commandDigest: verified.profileDigest, openCommand: async () => ({ close, spawn: (_args: unknown, options: any) => { environment = options.env; cwd = options.cwd; return child; } }) });
    expect(await probeCopilotMetadata("github_pat_private_test", "gpt-5.6-luna")).toEqual(verified);
    expect(methods).toEqual(["initialize", "session/new", "session/set_model", "session/set_config_option"]);
    expect(environment.COPILOT_GITHUB_TOKEN).toBe("github_pat_private_test");
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NODE_OPTIONS", "SSH_AUTH_SOCK"]) expect(environment).not.toHaveProperty(key);
    expect(environment.HOME).toContain(cwd); expect(close).toHaveBeenCalledOnce();
    await expect(access(cwd)).rejects.toThrow();
  });
  it("retires a stubborn native descendant before releasing metadata state", async () => {
    let launcher: ChildProcessWithoutNullStreams | undefined;
    let providerPid = 0;
    let probe: ReturnType<typeof probeCopilotMetadata> | undefined;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const provider = `const readline=require("node:readline");process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stderr.write("provider-pid:"+process.pid+"\\n");
      readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);const result=m.method==="initialize"?{agentInfo:{version:"1.0.88"}}:m.method==="session/new"?{sessionId:"metadata",models:{availableModels:[{modelId:"gpt-5.6-luna",name:"GPT"}]}}:{};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");});`;
    const script = `const {spawn}=require("node:child_process");process.on("SIGTERM",()=>{});const c=spawn(process.execPath,["-e",${JSON.stringify(provider)}],{stdio:"inherit",detached:false});c.once("exit",()=>process.exit(0));`;
    const close = vi.fn(async () => { expect(alive(launcher!.pid!)).toBe(false); await vi.waitFor(() => expect(alive(providerPid)).toBe(false)); });
    mocks.verify.mockResolvedValue({ commandDigest: verified.profileDigest, openCommand: async () => ({ close, spawn: (_args: unknown, options: any) => {
      launcher = spawn(process.execPath, ["-e", script], { cwd: options.cwd, detached: true, stdio: "pipe" });
      launcher.stderr.on("data", value => { const match = /provider-pid:(\d+)/.exec(value.toString()); if (match) providerPid = Number(match[1]); });
      return launcher;
    } }) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      probe = probeCopilotMetadata("token");
      const result = await Promise.race([probe, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("metadata cleanup exceeded its bound")), 3500); })]);
      expect(result).toMatchObject({ status: "verified", promptSent: false });
      expect(providerPid).toBeGreaterThan(0); expect(close).toHaveBeenCalledOnce();
    } finally {
      if (timer) clearTimeout(timer);
      if (launcher?.pid) { try { process.kill(-launcher.pid, "SIGKILL"); } catch {} }
      if (probe) await probe.catch(() => undefined);
    }
  });
  it("fails metadata verification and retains private state when shutdown is unconfirmed", async () => {
    let cwd = "";
    const child = fakeChild(message => ({ result: message.method === "initialize" ? { agentInfo: { version: "1.0.88" } } : { sessionId: "metadata", models: { availableModels: [{ modelId: "gpt-5.6-luna" }] } } }), false);
    child.kill = vi.fn(() => false);
    const close = vi.fn(async () => {});
    mocks.verify.mockResolvedValue({ commandDigest: verified.profileDigest, openCommand: async () => ({ close, spawn: (_args: unknown, options: any) => { cwd = options.cwd; return child; } }) });
    try {
      expect(await probeCopilotMetadata("token")).toMatchObject({ status: "failed", code: "COPILOT_REQUEST_FAILED", promptSent: false });
      expect(close).toHaveBeenCalledOnce();
      await expect(access(cwd)).resolves.toBeUndefined();
    } finally { child.emit("close", 0); if (cwd) await rm(cwd, { recursive: true, force: true }); }
  });
  it("rejects an unavailable model without sending a prompt or selecting another model", async () => {
    const methods: string[] = [];
    const child = fakeChild(message => { methods.push(message.method); return { result: message.method === "initialize" ? { agentInfo: { version: "1.0.88" } } : { sessionId: "session", models: { availableModels: [{ modelId: "other" }] } } }; });
    const close = vi.fn(async () => {});
    mocks.verify.mockResolvedValue({ commandDigest: verified.profileDigest, openCommand: async () => ({ close, spawn: () => child }) });
    expect(await probeCopilotMetadata("token", "missing")).toMatchObject({ status: "failed", code: "COPILOT_MODEL_UNAVAILABLE", promptSent: false });
    expect(methods).toEqual(["initialize", "session/new"]); expect(close).toHaveBeenCalledOnce();
  });
  it("preserves model labels split inside every UTF-8 character across transport chunks", async () => {
    const child = fakeChild(() => undefined), rpc = createMetadataRpc(child);
    const result = { models: { availableModels: [{ modelId: "gpt-5.6-luna", name: "東京 🚀 café" }] } };
    const response = rpc.request("session/new", {});
    const wire = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 0, result })}\n`);
    for (const byte of wire) child.stdout.emit("data", Buffer.from([byte]));
    await expect(response).resolves.toEqual(result);
  });
  it("cannot dispatch semantic or prompt methods", () => {
    const child = fakeChild(() => undefined), rpc = createMetadataRpc(child);
    expect(() => rpc.request("session/prompt", {})).toThrow("cannot send");
    expect(() => rpc.request("tools/call", {})).toThrow("cannot send");
  });
  it("rejects outstanding calls when the provider dies", async () => {
    const child = fakeChild(() => undefined), rpc = createMetadataRpc(child);
    const promise = rpc.request("initialize", {}); child.emit("close", 1);
    await expect(promise).rejects.toThrow("provider exited");
  });
  it("accepts only current profile metadata and sanitized failures", () => {
    expect(validateCopilotMetadata(verified)).toEqual(verified);
    for (const mutation of [{ promptSent: true }, { profileDigest: "stale" }, { models: [] }, { models: [{ id: "bad id", label: "x" }] }, { models: [{ id: "safe", label: "github_pat_secret" }] }, { models: [...verified.models, ...verified.models] }]) {
      expect(validateCopilotMetadata({ ...verified, ...mutation })).toMatchObject({ status: "failed", code: "COPILOT_REQUEST_FAILED" });
    }
    const failure = validateCopilotMetadata({ status: "failed", code: "COPILOT_AUTH_REQUIRED", message: "github_pat_secret", promptSent: false });
    expect(failure).toMatchObject({ code: "COPILOT_AUTH_REQUIRED" }); expect(JSON.stringify(failure)).not.toContain("secret");
    expect(validateCopilotMetadata({ status: "failed", code: "untrusted", promptSent: false })).toMatchObject({ code: "COPILOT_REQUEST_FAILED" });
  });
});
