import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { access } from "node:fs/promises";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QUALIFIED_ACPX_PROFILES } from "./acpx/qualified-profiles.js";
const mocks = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock("./acpx/copilot-installation.js", () => ({ verifyCopilotInstallation: mocks.verify }));
import { createMetadataRpc, probeCopilotMetadata, validateCopilotMetadata } from "./copilot-metadata-probe.js";
function fakeChild(reply: (message: any) => unknown) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = vi.fn(() => { child.emit("close", 0); return true; });
  child.stdin = new Writable({ write(chunk, _encoding, done) {
    const message = JSON.parse(chunk.toString());
    const response = reply(message);
    if (response !== undefined) queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response as object })}\n`)));
    done();
  }, final(done) { queueMicrotask(() => child.emit("close", 0)); done(); } });
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
