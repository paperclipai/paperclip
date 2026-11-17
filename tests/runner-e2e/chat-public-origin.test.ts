import { mkdtemp, writeFile, chmod, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicHttpsOrigin, publicOriginReceiptMatches, publicProxySocketMatches, publicOriginReleaseMatches, samePublicProxyIdentity, publicOriginServerOverrides, publicOriginFingerprintIdentity, prepareOwnedPublicOrigin, readValidatedPublicOriginReceipt, type PublicOriginRequest, type ValidatedPublicOriginReceipt } from "./chat-public-origin.js";
const request: PublicOriginRequest = { schema: "paperclip.chat-public-origin-request.v1", executionId: "chat-catalog.agents.existing-grok-bot.codex", scenarioId: "agents.existing-grok-bot", attemptId: "a".repeat(32), backendOrigin: "http://127.0.0.1:42123", nonce: "b".repeat(48) };
const receipt: ValidatedPublicOriginReceipt = { ...request, schema: "paperclip.chat-public-origin.v1", publicOrigin: "https://attempt.example.test", routeVerifiedAt: "2026-10-27T12:00:00.000Z", proxy: { pid: 999999, uid: process.getuid!(), startedAt: "2026-10-27T11:59:00.000Z", executable: "/owned/proxy", executableSha256: "c".repeat(64), commandSha256: "d".repeat(64), workingDirectory: "/owned/private/control" } };
describe("finite owned public-origin handoff", () => {
  it("accepts exact independently recorded attempt binding, rejects stale attempt/nonce/source", () => {
    expect(publicOriginReceiptMatches(receipt, request)).toBe(true);
    for (const mutation of [{ attemptId: "e".repeat(32) }, { nonce: "e".repeat(48) }, { backendOrigin: "http://127.0.0.1:42124" }, { executionId: "another.agents.existing-grok-bot" }, { scenarioId: "goals.list" }]) expect(publicOriginReceiptMatches({ ...receipt, ...mutation }, request)).toBe(false);
    expect(publicOriginReceiptMatches({ ...receipt, undeclared: "input" } as typeof receipt, request)).toBe(false);
  });
  it("forbids HTTP, embedded credentials, alternate paths and loopback public origins", () => {
    expect(publicHttpsOrigin(receipt.publicOrigin)).toBe(true);
    for (const origin of ["http://attempt.example.test", "https://user:password@attempt.example.test", "https://attempt.example.test/path", "https://127.0.0.1", "https://localhost", "https://sub.localhost", "not a URL"]) expect(publicHttpsOrigin(origin)).toBe(false);
  });
  it("pins process start, owner, executable, command and owned cwd rather than PID alone", () => {
    expect(samePublicProxyIdentity({ ...receipt.proxy }, receipt.proxy)).toBe(true);
    for (const mutation of [{ startedAt: "2026-10-27T12:00:01.000Z" }, { uid: receipt.proxy.uid + 1 }, { executableSha256: "e".repeat(64) }, { commandSha256: "f".repeat(64) }, { workingDirectory: "/other" }]) expect(samePublicProxyIdentity({ ...receipt.proxy, ...mutation }, receipt.proxy)).toBe(false);
    expect(samePublicProxyIdentity(undefined, receipt.proxy)).toBe(false);
    expect(publicOriginReceiptMatches({ ...receipt, proxy: { ...receipt.proxy, pid: process.pid } }, request)).toBe(false);
  });
  it("requires the actual proxy's exact established loopback socket", () => {
    expect(publicProxySocketMatches("p9123\nn127.0.0.1:53555->127.0.0.1:42123\n", 53555, 42123)).toBe(true);
    for (const line of ["n127.0.0.1:53556->127.0.0.1:42123", "n127.0.0.1:53555->127.0.0.1:42124", "n10.0.0.1:53555->127.0.0.1:42123", "n127.0.0.1:42123->127.0.0.1:53555"]) expect(publicProxySocketMatches(line, 53555, 42123)).toBe(false);
  });
  it("rejects release without exact route and proxy teardown attestation", () => {
    const release = { schema: "paperclip.chat-public-origin-release.v1", executionId: request.executionId, attemptId: request.attemptId, nonce: request.nonce, publicRouteReleased: true, proxyReleased: true };
    expect(publicOriginReleaseMatches(release, request)).toBe(true);
    for (const mutation of [{ attemptId: "f".repeat(32) }, { nonce: "f".repeat(48) }, { publicRouteReleased: false }, { proxyReleased: false }, { extra: true }]) expect(publicOriginReleaseMatches({ ...release, ...mutation }, request)).toBe(false);
  });
  it("refuses forged/stale private receipts before inspecting an unrelated process", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "origin-control-")));
    try {
      await chmod(directory, 0o700);
      const filename = path.join(directory, "public-origin.json");
      await writeFile(filename, JSON.stringify({ ...receipt, attemptId: "f".repeat(32) }), { mode: 0o600 });
      await expect(readValidatedPublicOriginReceipt({ ...request, receiptPath: filename })).rejects.toThrow("no longer belongs");
      await chmod(filename, 0o644);
      await expect(readValidatedPublicOriginReceipt({ ...request, receiptPath: filename })).rejects.toThrow("Invalid private");
      const alias = path.join(directory, "alias.json"); await symlink(filename, alias);
      await expect(readValidatedPublicOriginReceipt({ ...request, receiptPath: alias })).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("refuses a configured public route on a nonallowlisted case before writing a request", async () => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "origin-control-")));
    try {
      await chmod(directory, 0o700);
      await expect(prepareOwnedPublicOrigin({ ...request, executionId: "goals.list", scenarioId: "goals.list", controlDirectory: directory, temporaryRoot: directory, privateSecrets: [] })).rejects.toThrow("forbidden outside");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("preserves default source isolation and changes only finite public advertisements", async () => {
    expect(await prepareOwnedPublicOrigin({ ...request, temporaryRoot: "/never-used", privateSecrets: [] })).toBeUndefined();
    expect(publicOriginServerOverrides(undefined)).toEqual({});
    expect(publicOriginServerOverrides(receipt)).toEqual({ PAPERCLIP_PUBLIC_URL: receipt.publicOrigin, PAPERCLIP_AUTH_PUBLIC_BASE_URL: receipt.publicOrigin, PAPERCLIP_MANAGED_RUNTIME_PUBLIC_URL: receipt.publicOrigin, PAPERCLIP_ALLOWED_HOSTNAMES: "127.0.0.1" });
    expect(publicOriginFingerprintIdentity("goals.list", "goals.list", {}).selected).toBe(false);
    const identity = publicOriginFingerprintIdentity(request.executionId, request.scenarioId, { PAPERCLIP_CHAT_EVAL_PUBLIC_ORIGIN_CONTROL_DIR: "/private/never-retained" });
    expect(identity.selected && identity.configured).toBe(true);
    expect(JSON.stringify(identity)).not.toContain("/private/never-retained");
  });
});
