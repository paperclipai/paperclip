import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { ownerRefusalCode, startEphemeralMigrationService, type EphemeralMigrationResult } from "./ephemeral-migration-service.js";

let service: Awaited<ReturnType<typeof startEphemeralMigrationService>> | undefined;
afterEach(async () => { await service?.close(); service = undefined; vi.restoreAllMocks(); });
const result = (): EphemeralMigrationResult => ({ counts: { files: 2 }, eligibility: { eligible: true, blockers: [] }, decisionSigningSecret: randomBytes(32).toString("base64") });
async function start(migrate: Parameters<typeof startEphemeralMigrationService>[0]["migrate"], timeoutMs?: number) {
  const id = randomUUID(), token = randomBytes(32).toString("base64url"), commit = "a".repeat(40);
  service = await startEphemeralMigrationService({ id, commit, token, port: 0, host: "127.0.0.1", migrate, timeoutMs });
  const address = service.server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener");
  const request = (pathname: string, method = "GET", authorized = true) => fetch(`http://127.0.0.1:${address.port}${pathname}`, {
    method, headers: authorized ? { authorization: `Bearer ${token}` } : {},
  });
  return { request, id, commit };
}

it("keeps the original key out of health/status and exports only after authenticated successful migration", async () => {
  const original = result();
  let finish!: (value: EphemeralMigrationResult) => void;
  const { request, id, commit } = await start(() => new Promise(resolve => { finish = resolve; }));
  expect((await request("/health", "GET", false)).status).toBe(200);
  expect((await request("/status", "GET", false)).status).toBe(401);
  expect((await request("/export", "POST", false)).status).toBe(401);
  expect((await request("/export", "POST")).status).toBe(409);
  expect((await request("/api/companies")).status).toBe(404);
  finish(original); await service!.finished;
  const status = await request("/status");
  expect(status.headers.get("cache-control")).toBe("no-store");
  const body = await status.json();
  expect(body).toMatchObject({ id, commit, state: "ready", counts: original.counts });
  expect(JSON.stringify(body)).not.toContain(original.decisionSigningSecret);
  expect(await (await request("/export", "POST")).json()).toMatchObject({ id, commit, decisionSigningSecret: original.decisionSigningSecret });
});

it("fails closed without exposing owner errors or credentials", async () => {
  const { request } = await start(async () => { throw new Error("provider rejected secret-value at https://private.invalid"); });
  await service!.finished;
  expect(await (await request("/status")).json()).toMatchObject({ state: "blocked", failure: "owner_migration_failed" });
  expect((await request("/export", "POST")).status).toBe(409);
});

it("reports an owner's structured refusal and the workspace it was moving, in the receipt and the deployment log", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const workspaceId = randomUUID();
  const refusal = "remote_workspace_migration_blocked:archived_git_source_unavailable,local_source_unsafe_or_missing";
  const { request } = await start(async (_signal, phase) => {
    phase(`workspace:${workspaceId}`);
    throw new Error(refusal);
  });
  await service!.finished;
  expect(await (await request("/status")).json()).toMatchObject({ state: "blocked", phase: `workspace:${workspaceId}`, failure: refusal });
  expect(logged.mock.calls.map(call => JSON.parse(String(call[0]))))
    .toEqual([{ event: "ephemeral_migration_blocked", phase: `workspace:${workspaceId}`, failure: refusal }]);
});

it("logs only the sanitized code for an arbitrary owner error", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  await start(async () => { throw new Error("provider rejected secret-value at https://private.invalid"); });
  await service!.finished;
  expect(logged.mock.calls.map(call => JSON.parse(String(call[0]))))
    .toEqual([{ event: "ephemeral_migration_blocked", phase: "configuration", failure: "owner_migration_failed" }]);
});

it.each([
  ["remote_workspace_migration_blocked:workspace_recovery_unresolved", "remote_workspace_migration_blocked:workspace_recovery_unresolved"],
  ["active_execution_requires_drain", "active_execution_requires_drain"],
  // Only known reason-list owners may carry text after a colon.
  ["provider:secretvalue", "owner_migration_failed"],
  ["a:b:c", "owner_migration_failed"],
  // A known owner keeps its code when its reasons are malformed.
  ["remote_workspace_migration_blocked:", "remote_workspace_migration_blocked"],
  ["remote_workspace_migration_blocked:Secret", "remote_workspace_migration_blocked"],
  ["remote_workspace_migration_blocked:a:b", "remote_workspace_migration_blocked"],
  ["x".repeat(81), "owner_migration_failed"],
])("reports %s as %s", (message, expected) => {
  expect(ownerRefusalCode(new Error(message))).toBe(expected);
});

it("keeps the owner and its first reasons when a refusal names too many", () => {
  const reasons = Array.from({ length: 40 }, (_, index) => `reason_${String.fromCharCode(97 + index % 26)}${index >= 26 ? "_again" : ""}`);
  const code = ownerRefusalCode(new Error(`remote_workspace_migration_blocked:${reasons.join(",")}`));
  expect(code).toBe(`remote_workspace_migration_blocked:${[...reasons.slice(0, 31), "more_reasons_truncated"].join(",")}`);
  expect(ownerRefusalCode(new Error(`remote_workspace_migration_blocked:${reasons.slice(0, 17).join(",")}`)))
    .toBe(`remote_workspace_migration_blocked:${reasons.slice(0, 17).join(",")}`);
});

it("rejects incomplete eligibility even when a key was recovered", async () => {
  const { request } = await start(async () => ({ ...result(), eligibility: { eligible: false, blockers: ["legacy_data"] } }));
  await service!.finished;
  expect((await request("/export", "POST")).status).toBe(409);
  expect(service!.receipt().failure).toBe("incomplete_migration_receipt");
});

it("publishes a blocked deadline immediately and never exports a late completion", async () => {
  let finish!: (value: EphemeralMigrationResult) => void;
  let aborted!: Promise<void>;
  const { request } = await start(signal => {
    aborted = new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return new Promise(resolve => { finish = resolve; });
  }, 20);
  await aborted;
  expect(service!.receipt()).toMatchObject({ state: "blocked", failure: "maintenance_deadline_exceeded" });
  finish(result()); await service!.finished;
  expect((await request("/export", "POST")).status).toBe(409);
});

it("expires successful export authority at the original maintenance deadline", async () => {
  let expired!: Promise<void>;
  const { request } = await start(async signal => {
    expired = new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return result();
  }, 100);
  await service!.finished;
  expect(service!.receipt().state).toBe("ready");
  await expired;
  expect(service!.receipt()).toMatchObject({ state: "blocked", failure: "maintenance_deadline_exceeded" });
  expect((await request("/export", "POST")).status).toBe(409);
});
