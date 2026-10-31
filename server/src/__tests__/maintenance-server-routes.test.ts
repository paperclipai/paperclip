import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { createDb } from "@paperclipai/db";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { CLOUD_RUNTIME_IDENTITY_AUDIENCE, CLOUD_RUNTIME_IDENTITY_ISSUER, CLOUD_RUNTIME_IDENTITY_JWS_TYPE } from "../services/cloud-runtime-identity.js";
import { prepareMaintenanceRuntime } from "./helpers/maintenance/runtime-build.js";
import { startMaintenanceServer } from "./helpers/maintenance/server-harness.js";

let databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_MAINTENANCE_BOOT_TEST_DATABASE_URL");
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
async function clearDatabase() {
  if (!temporary && !new URL(databaseUrl!).pathname.endsWith("_test")) throw new Error("Maintenance boot requires an owned disposable _test database");
  const fixture = createDb(databaseUrl!, { maxConnections: 1 });
  try {
    const tables = await fixture.$client<{ tablename: string }[]>`select tablename from pg_tables where schemaname='public'`;
    if (tables.length) await fixture.$client.unsafe(`truncate ${tables.map(table => `"${table.tablename.replaceAll('"', '""')}"`).join(",")} cascade`);
  } finally { await fixture.$client.end(); }
}
function receipt(queries: Array<{ protocol: string; sql: string; fingerprint: string }>) {
  const groups = new Map<string, { fingerprint: string; protocol: string; calls: number; tables: string[] }>();
  for (const query of queries) {
    const key = `${query.protocol}:${query.fingerprint}`;
    const entry = groups.get(key) ?? { fingerprint: query.fingerprint, protocol: query.protocol, calls: 0,
      tables: [...new Set([...query.sql.matchAll(/(?:from|join|update|into)\s+"?([a-z_][a-z_0-9]*)"?/gi)].map(match => match[1]!))] };
    entry.calls++; groups.set(key, entry);
  }
  return [...groups.values()];
}
describe("assembled maintenance server production wiring", () => {
  beforeAll(async () => {
    await prepareMaintenanceRuntime();
    if (!databaseUrl) { temporary = await startEmbeddedPostgresTestDatabase("maintenance-server-"); databaseUrl = temporary.connectionString; }
  }, 150_000);
  afterAll(async () => { await temporary?.cleanup(); });
  it("detects legacy aggregate recovery SQL after an empty real server boot settles", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!);
    try {
      const settled = await server.settled();
      expect(settled.startup.phase).toBe("ready");
      expect(settled.outgoingHttpRequests).toBe(0);
      const baseline = server.proxy.queries.length, initialFrames = server.proxy.frames;
      await delay(31_000);
      await server.settled();
      const repeated = server.proxy.queries.slice(baseline);
      expect(repeated.length).toBeGreaterThan(0);
      expect(repeated.some(query => query.sql.includes('"heartbeat_runs"'))).toBe(true);
      expect(server.proxy.errors).toEqual([]);
      expect((await server.snapshot()).outgoingHttpRequests).toBe(0);
      await writeFile(path.join(server.directory, "measurement.json"), JSON.stringify({ phase: "legacy-positive-control",
        observationMs: 31_000, startupQueries: baseline, startup: receipt(server.proxy.queries.slice(0, baseline)),
        repeatedQueries: repeated.length, repeated: receipt(repeated), initialFrames, finalFrames: server.proxy.frames, outgoingHttpRequests: 0 }, null, 2));
    } finally { await server.stop(); }
  }, 150_000);
  it("keeps the disabled-heartbeat boot quiet across two former hourly windows with a qualified child clock", async () => {
    await clearDatabase();
    const server = await startMaintenanceServer(databaseUrl!, { enabled: false, clock: true });
    try {
      await server.settled();
      await server.freeze();
      const baseline = server.proxy.queries.length, start = (await server.snapshot()).now;
      for (let step = 0; step < 240; step++) {
        await server.advance(30_000);
        await server.settled(10);
      }
      const after = await server.snapshot();
      expect(after.now - start).toBe(2 * 60 * 60_000);
      expect(server.proxy.queries.length).toBe(baseline);
      expect(after.outgoingHttpRequests).toBe(0);
      expect(after.network.nonDatabaseConnections).toBe(0);
      expect(server.proxy.errors).toEqual([]);
      await writeFile(path.join(server.directory, "measurement.json"), JSON.stringify({ phase: "disabled-empty-boot-clock",
        clockAdvanceMs: after.now - start, stepMs: 30_000, ioSettledBetweenSteps: true,
        startupQueries: baseline, startup: receipt(server.proxy.queries), frames: server.proxy.frames, network: after.network, measuredQueries: 0, outgoingHttpRequests: 0 }, null, 2));

      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Configured idle maintenance fixture" });
      await server.api("PATCH", "/instance/settings/experimental", { enableExternalObjects: true, enableStatusCards: true });
      const history = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, { title: "Retained completed history", status: "done" });
      await server.advance(30_000);
      await server.settled();
      const persisted = createDb(databaseUrl!, { maxConnections: 1 });
      try {
        const [saved] = await persisted.$client`select company_id, status from issues where id=${history.id}`;
        expect(saved).toMatchObject({ company_id: company.id, status: "done" });
      } finally { await persisted.$client.end(); }
      const historyBaseline = server.proxy.queries.length;
      await server.drain();
      for (let step = 0; step < 3; step++) { await server.advance(30_000); await server.settled(10); }
      await server.resume(); await server.settled();
      const resumed = server.proxy.queries.length;
      for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(resumed);
      expect((await server.snapshot()).outgoingHttpRequests).toBe(0);
      await writeFile(path.join(server.directory, "history-measurement.json"), JSON.stringify({ phase: "disabled-configured-history-drain",
        companyId: company.id, issueId: history.id, historyBaseline, resumedQueries: resumed,
        postResumeClockMs: 2 * 60 * 60_000, measuredQueries: server.proxy.queries.length - resumed,
        frames: server.proxy.frames, outgoingHttpRequests: 0 }, null, 2));
    } finally { await server.stop(); }
  }, 150_000);

  it("processes the first ordinary external-object producer committed during idle drain and becomes quiet again", async () => {
    await clearDatabase();
    const providerRequests: string[] = [];
    const provider = createServer((req, res) => {
      providerRequests.push(req.url!);
      res.setHeader("Content-Type", "application/json");
      if (!/^\/repos\/maintenance\/example\/pulls\/[12]$/.test(req.url!)) { res.statusCode = 500; res.end(JSON.stringify({ error: "Unexpected simulated GitHub request" })); return; }
      if (req.url!.endsWith("/2") && providerRequests.filter(url => url.endsWith("/2")).length === 1) {
        res.statusCode = 503; res.setHeader("Retry-After", "2"); res.end(JSON.stringify({ message: "Controlled provider outage" })); return;
      }
      const number = Number(req.url!.split("/").at(-1));
      res.end(JSON.stringify({ id: number, number, state: "closed", merged: true, merged_at: new Date().toISOString(),
        title: "Controlled merged pull request", html_url: `https://github.com/maintenance/example/pull/${number}`, user: { login: "fixture" } }));
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    const providerAddress = provider.address();
    if (!providerAddress || typeof providerAddress === "string") throw new Error("Simulated GitHub failed to bind");
    const server = await startMaintenanceServer(databaseUrl!, { enabled: false, clock: true,
      githubOrigin: `http://127.0.0.1:${providerAddress.port}` });
    const fixture = createDb(databaseUrl!, { maxConnections: 1 });
    let reserved: Awaited<ReturnType<typeof fixture.$client.reserve>> | undefined;
    let pendingIssue: Promise<{ id: string }> | undefined;
    try {
      await server.settled();
      const company = await server.api<{ id: string }>("POST", "/companies", { name: "Drain activation" });
      await server.api("PATCH", "/instance/settings/experimental", { enableExternalObjects: true });
      await server.advance(30_000); await server.settled();
      await fixture.$client.unsafe(`create or replace function maintenance_hold_issue() returns trigger language plpgsql as $$begin
        if new.title = 'First write during idle drain' then perform pg_advisory_xact_lock(913701); end if;
        return new; end$$`);
      await fixture.$client.unsafe(`create trigger maintenance_hold_issue before insert on issues for each row execute function maintenance_hold_issue()`);
      reserved = await fixture.$client.reserve();
      await reserved`select pg_advisory_lock(913701)`;
      const before = server.proxy.queries.length;
      pendingIssue = server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, {
        title: "First write during idle drain", description: "https://github.com/maintenance/example/pull/1", status: "done",
      });
      void pendingIssue.catch(() => {});
      await expect.poll(() => server.proxy.queries.slice(before).some(query => /insert into "issues"/.test(query.sql)), { timeout: 10_000 }).toBe(true);
      await server.drain();
      await reserved`select pg_advisory_unlock(913701)`; reserved.release(); reserved = undefined;
      const issue = await pendingIssue;
      await server.settled();
      expect(providerRequests).toEqual([]);
      const [waiting] = await fixture.$client`select eo.company_id, eo.is_terminal, eo.last_resolved_at from external_objects eo
        join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${issue.id}`;
      expect(waiting).toMatchObject({ company_id: company.id, is_terminal: false, last_resolved_at: null });
      const draining = server.proxy.queries.length;
      for (let step = 0; step < 4; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(draining);
      await server.resume(); await server.advance(30_000); await server.settled();
      const [resolved] = await fixture.$client`select eo.company_id, eo.is_terminal, eo.status_key, floor(extract(epoch from eo.last_resolved_at) * 1000)::float8 as resolved_ms from external_objects eo
        join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${issue.id}`;
      expect(resolved).toMatchObject({ company_id: company.id, is_terminal: true, status_key: "merged", resolved_ms: expect.any(Number) });
      expect(resolved!.resolved_ms).toBeGreaterThan(0);
      expect(resolved!.resolved_ms).toBeLessThanOrEqual((await server.snapshot()).now);
      expect(providerRequests).toEqual(["/repos/maintenance/example/pulls/1"]);
      const settledQueries = server.proxy.queries.length, network = await server.snapshot();
      for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(settledQueries);
      expect(providerRequests).toHaveLength(1);
      expect((await server.snapshot()).outgoingHttpRequests).toBe(network.outgoingHttpRequests);
      await writeFile(path.join(server.directory, "external-object-measurement.json"), JSON.stringify({
        phase: "ordinary-issue-producer-commit-during-drain", providerBoundary: "simulated GitHub HTTP; real application/database/transactions",
        companyId: company.id, issueId: issue.id, resolved, drainedClockMs: 120_000, drainedQueries: 0,
        postResolveClockMs: 7_200_000, postResolveQueries: 0, providerRequests, frames: server.proxy.frames, network,
      }, null, 2));

      const retryIssue = await server.api<{ id: string }>("POST", `/companies/${company.id}/issues`, {
        title: "Retry after idle drain", description: "https://github.com/maintenance/example/pull/2", status: "done",
      });
      await server.advance(1_000); await server.settled(100);
      const [failed] = await fixture.$client`select eo.last_error_code, floor(extract(epoch from eo.next_refresh_at) * 1000)::float8 as next_ms
        from external_objects eo join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${retryIssue.id}`;
      expect(failed!.last_error_code).toBe("github_unreachable");
      expect(failed!.next_ms).toBeGreaterThan((await server.snapshot()).now);
      await server.drain(); await server.settled();
      const retryDrainQueries = server.proxy.queries.length;
      for (let step = 0; step < 4; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(retryDrainQueries);
      expect(providerRequests.filter(url => url.endsWith("/2"))).toHaveLength(1);
      await server.resume(); await server.advance(30_000); await server.settled();
      const [retried] = await fixture.$client`select eo.is_terminal, eo.status_key, eo.last_error_code from external_objects eo
        join external_object_mentions em on em.object_id=eo.id where em.source_issue_id=${retryIssue.id}`;
      expect(retried).toMatchObject({ is_terminal: true, status_key: "merged", last_error_code: null });
      expect(providerRequests.filter(url => url.endsWith("/2"))).toHaveLength(2);
      const retrySettled = server.proxy.queries.length;
      for (let step = 0; step < 20; step++) { await server.advance(30_000); await server.settled(10); }
      expect(server.proxy.queries.length).toBe(retrySettled);
      await writeFile(path.join(server.directory, "retry-measurement.json"), JSON.stringify({ phase: "provider-failure-retry-across-drain",
        providerBoundary: "simulated GitHub HTTP 503 then merged", retryIssueId: retryIssue.id, failed, retried,
        drainedClockMs: 120_000, drainedQueries: 0, quietAfterRetryMs: 600_000, quietAfterRetryQueries: 0,
        providerRequests, frames: server.proxy.frames }, null, 2));
    } finally {
      if (reserved) { await reserved`select pg_advisory_unlock(913701)`.catch(() => {}); reserved.release(); }
      await pendingIssue?.catch(() => {});
      await fixture.$client.unsafe("drop trigger if exists maintenance_hold_issue on issues").catch(() => {});
      await fixture.$client.unsafe("drop function if exists maintenance_hold_issue()").catch(() => {});
      await fixture.$client.end(); await server.stop();
      provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
    }
  }, 150_000);

  it("keeps an actual Cloud warm standby quiet and activates after a normally signed durable claim", async () => {
    await clearDatabase();
    const pair = generateKeyPairSync("ed25519");
    const publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "maintenance-test-key", use: "sig", alg: "EdDSA" };
    const storageRequests: string[] = [];
    const storage = createServer((req, res) => { storageRequests.push(req.url!); res.statusCode = 500; res.end("Unexpected S3 request in empty standby fixture"); });
    await new Promise<void>(resolve => storage.listen(0, "127.0.0.1", resolve));
    const address = storage.address();
    if (!address || typeof address === "string") throw new Error("Simulated S3 failed to bind");
    const server = await startMaintenanceServer(databaseUrl!, { clock: true,
      cloud: { jwks: JSON.stringify({ keys: [publicJwk] }), s3Origin: `http://127.0.0.1:${address.port}`, standby: true } })
      .catch(async error => { storage.closeAllConnections(); await new Promise<void>(resolve => storage.close(() => resolve())); throw error; });
    try {
      const standby = await server.settled(500, 1); await server.freeze();
      expect(standby.idle.active).toBe(1);
      const before = server.proxy.queries.length;
      for (let step = 0; step < 240; step++) { await server.advance(30_000); await server.settled(10, 1); }
      const health = await fetch(`http://127.0.0.1:${server.port}/api/health`, { signal: AbortSignal.timeout(10_000) });
      expect(health.status).toBe(200); expect(await health.json()).toMatchObject({ warmStandby: true });
      expect(server.proxy.queries.length).toBe(before);
      expect(storageRequests).toEqual([]);
      expect((await server.snapshot()).network.nonDatabaseConnections).toBe(0);
      const now = Math.floor((await server.snapshot()).now / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: CLOUD_RUNTIME_IDENTITY_JWS_TYPE, kid: publicJwk.kid })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ v: 1, iss: CLOUD_RUNTIME_IDENTITY_ISSUER, aud: CLOUD_RUNTIME_IDENTITY_AUDIENCE,
        sub: "maintenance-stack", claimId: "maintenance-claim", previousOrigin: "https://pool-maintenance.staging.paperclip.app",
        canonicalOrigin: "https://claimed-maintenance.staging.paperclip.app", stackSlug: "claimed-maintenance", iat: now, exp: now + 300 })).toString("base64url");
      const assertion = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`, "ascii"), pair.privateKey).toString("base64url")}`;
      const claimed = await fetch(`http://127.0.0.1:${server.port}/api/health`, {
        headers: { "x-paperclip-cloud-runtime-identity": assertion }, signal: AbortSignal.timeout(10_000),
      });
      expect(claimed.status).toBe(200); expect((await claimed.json()).warmStandby).toBeUndefined();
      await server.advance(30_000); const afterClaim = await server.settled();
      expect(afterClaim.idle.active).toBe(0);
      expect(server.proxy.queries.length).toBeGreaterThan(before);
      const fixture = createDb(databaseUrl!, { maxConnections: 1 });
      try {
        const [transfers] = await fixture.$client`select count(*)::integer as count from company_transfer_runs`;
        expect(transfers!.count).toBe(0);
        const [identity] = await fixture.$client`select general from instance_settings where singleton_key='cloud-runtime-identity/v1'`;
        expect(identity!.general).toMatchObject({ stackId: "maintenance-stack", claimId: "maintenance-claim", canonicalOrigin: "https://claimed-maintenance.staging.paperclip.app" });
      } finally { await fixture.$client.end(); }
      await writeFile(path.join(server.directory, "standby-measurement.json"), JSON.stringify({ phase: "real-cloud-standby-signed-claim",
        cloudBoundary: "actual managed configuration, local S3 HTTP guard, generated Ed25519 trust root; no production Cloud claim",
        clockMs: 7_200_000, standbyQueries: 0,
        deferredStartupIntent: { count: 1, queue: "import-spool-cleanup", producer: "companyTransferRunService.recoverStrandedApplyingRuns",
          reason: "Cloud standby disables both reconciliation and dispatch", releasedAfterSignedClaim: true, boundedResumeMs: 30_000, sleepEligibleWhileHeld: false }, storageRequests, beforeClaimQueries: before, afterClaimQueries: server.proxy.queries.length,
        frames: server.proxy.frames, network: await server.snapshot() }, null, 2));
    } finally {
      await server.stop(); storage.closeAllConnections(); await new Promise<void>(resolve => storage.close(() => resolve()));
    }
  }, 150_000);

});
