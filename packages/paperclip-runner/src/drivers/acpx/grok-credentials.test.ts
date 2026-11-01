import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialHomeWithAvailableLeasePorts, credentialLeasePorts } from "../../../test/credential-lease-fixture.js";
import { stageManagedGrokCredential } from "./grok-credentials.js";
import { createSanitizedAcpxSpawnInput } from "./environment.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { requireVerifiedAcpxModel } from "./model-verification.js";
import { decideAcpxPermission } from "./permission-policy.js";

const roots: string[] = [];
const credential = JSON.stringify({ "https://accounts.x.ai::11111111-1111-4111-8111-111111111111": { key: "test-token", refresh_token: "test-refresh" } });
async function home() {
  return await credentialHomeWithAvailableLeasePorts(async () => {
    const path = await mkdtemp(join(tmpdir(), "grok-credential-test-"));
    roots.push(path);
    return path;
  });
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("Grok isolated credentials", () => {
  it("selects a fresh home before staging when unrelated listeners occupy two candidates", async () => {
    const collision = await home();
    const ports = credentialLeasePorts(collision);
    const first = await occupyPort(ports[0]!);
    let second: Awaited<ReturnType<typeof occupyPort>> | undefined;
    let lease: Awaited<ReturnType<typeof stageManagedGrokCredential>> | undefined;
    try {
      second = await occupyPort(ports[1]!);
      await writeFile(join(collision, "auth.json"), "unchanged", { mode: 0o600 });
      const nextHome = vi.fn().mockResolvedValueOnce(collision).mockImplementation(home);
      const selected = await credentialHomeWithAvailableLeasePorts(nextHome);
      expect(selected).not.toBe(collision);
      expect(nextHome).toHaveBeenCalledTimes(2);
      expect(await readFile(join(collision, "auth.json"), "utf8")).toBe("unchanged");
      await expect(occupyPort(ports[0]!)).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(occupyPort(ports[1]!)).rejects.toMatchObject({ code: "EADDRINUSE" });
      lease = await stageManagedGrokCredential({ agentHomeDirectory: selected,
        environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential } });
      expect(lease.lifetimeFenceCandidates).toEqual(credentialLeasePorts(selected));
      await expect(stageManagedGrokCredential({ agentHomeDirectory: selected,
        environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential } })).rejects.toThrow(/active lease|owned/);
    } finally {
      await Promise.all([lease?.close(), second?.close(), first.close()]);
    }
  });
  it("bounds fixture collisions and releases partial reservations without closing a foreign listener", async () => {
    const collision = await home();
    const ports = credentialLeasePorts(collision);
    const foreign = await occupyPort(ports[1]!);
    let released: Awaited<ReturnType<typeof occupyPort>> | undefined;
    try {
      const nextHome = vi.fn(async () => collision);
      await expect(credentialHomeWithAvailableLeasePorts(nextHome)).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(nextHome).toHaveBeenCalledTimes(8);
      released = await occupyPort(ports[0]!);
      await expect(occupyPort(ports[1]!)).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(readFile(join(collision, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await Promise.all([released?.close(), foreign.close()]);
    }
  });
  it("releases all successful fixture reservations before returning the home", async () => {
    const directory = await home();
    const reservations: Awaited<ReturnType<typeof occupyPort>>[] = [];
    try {
      for (const port of credentialLeasePorts(directory)) reservations.push(await occupyPort(port));
      expect(reservations).toHaveLength(3);
    } finally {
      await Promise.all(reservations.map(reservation => reservation.close()));
    }
  });
  it("propagates non-collision fixture failures without retrying", async () => {
    const error = Object.assign(new Error("private home unavailable"), { code: "EACCES" });
    const nextHome = vi.fn().mockRejectedValue(error);
    await expect(credentialHomeWithAvailableLeasePorts(nextHome)).rejects.toBe(error);
    expect(nextHome).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "{}" }, { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: "not-json" }, { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential, XAI_API_KEY: "test-key" }])("rejects missing, malformed and ambiguous sources", async environment => {
    await expect(stageManagedGrokCredential({ agentHomeDirectory: await home(), environment })).rejects.toThrow(/required|malformed|ambiguous/);
  });
  it("stages only subscription auth privately and retains refreshed auth until controller copyback", async () => {
    const directory = await home();
    const lease = await stageManagedGrokCredential({ agentHomeDirectory: directory, environment: { PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET: credential } });
    expect(lease.lifetimeFenceCandidates).toEqual(credentialLeasePorts(directory));
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

async function occupyPort(port: number): Promise<{ close(): Promise<void> }> {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
  });
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
