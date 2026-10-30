import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageManagedGrokCredential } from "./grok-credentials.js";
import { createSanitizedAcpxSpawnInput } from "./environment.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { requireVerifiedAcpxModel } from "./model-verification.js";
import { decideAcpxPermission } from "./permission-policy.js";

const roots: string[] = [];
const credential = JSON.stringify({ "https://accounts.x.ai::11111111-1111-4111-8111-111111111111": { key: "test-token", refresh_token: "test-refresh" } });
async function home() { const path = await mkdtemp(join(tmpdir(), "grok-credential-test-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Grok isolated credentials", () => {
  it.each([{}, { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "{}" }, { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "not-json" }, { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential, XAI_API_KEY: "test-key" }])("rejects missing, malformed and ambiguous sources", async environment => {
    await expect(stageManagedGrokCredential({ agentHomeDirectory: await home(), environment })).rejects.toThrow(/required|malformed|ambiguous/);
  });
  it("stages only subscription auth privately and retains refreshed auth until controller copyback", async () => {
    const directory = await home();
    const lease = await stageManagedGrokCredential({ agentHomeDirectory: directory, environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential } });
    expect((await stat(join(directory, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(directory, "auth.json"), "utf8")).toBe(credential);
    const refreshed = credential.replace("test-token", "refreshed-token");
    await writeFile(join(directory, "auth.json"), refreshed, { mode: 0o600 });
    await Promise.all([lease.close(), lease.close()]);
    await expect(readFile(join(directory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, "auth-refresh.json"), "utf8")).toBe(refreshed);
    await lease.close();
  });
  it.each([true, false])("removes diagnostic logs after shutdown without removing session history (admitted=%s)", async retainRefresh => {
    const directory = await home();
    const lease = await stageManagedGrokCredential({ agentHomeDirectory: directory,
      environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential }, retainRefresh: () => retainRefresh });
    await mkdir(join(directory, "logs"));
    await mkdir(join(directory, "sessions"));
    await writeFile(join(directory, "logs", "unified.jsonl"), credential, { mode: 0o600 });
    await writeFile(join(directory, "sessions", "session.json"), "resume-state", { mode: 0o600 });
    await lease.close();
    await expect(stat(join(directory, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(directory, "sessions", "session.json"), "utf8")).toBe("resume-state");
    if (retainRefresh) expect(await readFile(join(directory, "auth-refresh.json"), "utf8")).toBe(credential);
    else await expect(stat(join(directory, "auth-refresh.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not stage subscription credentials for an explicit API key", async () => {
    const directory = await home();
    const lease = await stageManagedGrokCredential({ agentHomeDirectory: directory, environment: { XAI_API_KEY: "test-key" } });
    await expect(readFile(join(directory, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await lease.close();
    await expect(readFile(join(directory, "auth-refresh.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("fences concurrent refresh owners and removes a stale refresh before the next turn", async () => {
    const directory = await home();
    const options = { agentHomeDirectory: directory, environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential } };
    const first = await stageManagedGrokCredential(options);
    await expect(stageManagedGrokCredential(options)).rejects.toThrow(/active lease|owned/);
    await first.close();
    const second = await stageManagedGrokCredential(options);
    await expect(readFile(join(directory, "auth-refresh.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await second.close();
  });
  it("rejects a substituted refresh symlink without releasing ownership or copying its target", async () => {
    const directory = await home();
    const options = { agentHomeDirectory: directory, environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential } };
    const lease = await stageManagedGrokCredential(options);
    const target = join(await home(), "private.json");
    await writeFile(target, "unrelated", { mode: 0o600 });
    await rm(join(directory, "auth.json"));
    await symlink(target, join(directory, "auth.json"));
    await expect(lease.close()).rejects.toThrow();
    await expect(stageManagedGrokCredential(options)).rejects.toThrow(/active lease|owned/);
    expect(await readFile(target, "utf8")).toBe("unrelated");
    await rm(join(directory, "auth.json"));
    await writeFile(join(directory, "auth.json"), credential, { mode: 0o600 });
    await lease.close();
  });
  it("never passes other providers, host homes or the inline credential to Grok", () => {
    const result = createSanitizedAcpxSpawnInput({ XAI_API_KEY: "selected", HOME: "/host", GROK_HOME: "/host/.grok", OPENAI_API_KEY: "other", PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential }, "grok");
    expect(result.env).toEqual({ XAI_API_KEY: "selected" });
  });
  it("cannot pass model verification with a missing or mismatched model", async () => {
    const profile = resolveQualifiedAcpxProfile("grok", "grok-4.7");
    for (const status of [{}, { models: { currentModelId: "grok-other" } }]) {
      await expect(requireVerifiedAcpxModel({ getStatus: async () => status, setModel: async () => {} }, profile)).rejects.toMatchObject({ code: "ACPX_EFFECTIVE_MODEL_MISMATCH" });
    }
  });
  it("keeps untrusted read hints and Paperclip-looking tools behind the selected approval policy", () => {
    const request = { inferredKind: "read", raw: { toolCall: { title: "mcp__paperclip__finish_task" } } };
    expect(decideAcpxPermission("grok", "approve-reads", request)).toBe("delegate");
    expect(decideAcpxPermission("grok", "approve-paperclip", request)).toBe("delegate");
    expect(decideAcpxPermission("grok", "deny-all", request)).toBe("reject_once");
    expect(decideAcpxPermission("grok", "approve-all", request)).toBe("allow_once");
  });
});
