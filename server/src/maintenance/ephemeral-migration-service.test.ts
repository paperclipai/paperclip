import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { startEphemeralMigrationService, type EphemeralMigrationResult } from "./ephemeral-migration-service.js";

let service: Awaited<ReturnType<typeof startEphemeralMigrationService>> | undefined;
afterEach(async () => { await service?.close(); service = undefined; });
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
