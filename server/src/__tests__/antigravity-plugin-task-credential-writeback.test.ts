import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, companyMemberships, connectionGrants, createDb, environmentLeases, environments, heartbeatRuns, plugins, toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { registerPluginTaskCredentialHandoff } from "../services/plugin-task-credential-writeback.js";
import { settleDispatchedEnvironmentTask } from "../services/environment-task-runtime.js";
import { secretService } from "../services/secrets.js";
import { preparePluginRunnerCredentials } from "../services/native-runtime/plugin-runner-credentials.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

vi.mock("../services/subscription-refresh.js", () => ({ refreshSubscriptionConnection: async () => {} }));
const secretRead = vi.hoisted(() => ({ fail: false }));
vi.mock("../services/ai-connections.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/ai-connections.js")>();
  return { ...actual, aiConnectionService: (database: Parameters<typeof actual.aiConnectionService>[0]) => {
    const service = actual.aiConnectionService(database);
    return { ...service, credential: (async (...args: Parameters<typeof service.credential>) => {
      if (secretRead.fail) throw new Error("fixture secret store unavailable");
      return service.credential(...args);
    }) as typeof service.credential };
  } };
});
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
const SIGN_IN = "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET";
const signIn = (token: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  client_id: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com", client_secret: "fixture-client-secret",
  refresh_token: token, token_uri: "https://oauth2.googleapis.com/token",
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/aicode"],
  ...extra,
});
const google = { email: "alice@example.test", rotate: undefined as string | undefined, fail: false, calls: 0 };
function stubGoogle() {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    google.calls++;
    if (google.fail) throw new Error("fixture Google outage");
    return Response.json(url.includes("userinfo") ? { email_verified: true, email: google.email }
      : { access_token: "fixture-access", token_type: "Bearer", ...(google.rotate ? { refresh_token: google.rotate } : {}) });
  }));
}

suite("Google sign-in task credential writeback for plugin Runners", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string;
  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "antigravity-plugin-task-")));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "antigravity-plugin-task-fixture");
    database = await startEmbeddedPostgresTestDatabase("antigravity-plugin-task-"); db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  afterEach(() => { vi.unstubAllGlobals(); secretRead.fail = false; Object.assign(google, { email: "alice@example.test", rotate: undefined, fail: false, calls: 0 }); });

  async function fixture(saved = signIn("fixture-original", { project_id: "fixture-project" })) {
    stubGoogle();
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), pluginId = randomUUID(), environmentId = randomUUID(), leaseId = randomUUID();
    const owner = `fixture-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Google task credential fixture", issuePrefix: `G${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "paperclip_runner" });
    await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
    const service = aiConnectionService(db);
    await service.save(companyId, owner, { provider: "google", method: "subscription", ownership: "personal", name: "Google fixture",
      loginSessionId: "fixture", agentIds: [], allAgents: true }, saved, undefined, undefined, undefined, "alice@example.test");
    const managed = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: owner, adapterType: "paperclip_runner",
      binding: { mode: "responsible_user", provider: "google", method: "subscription" },
      config: { provider: "acpx", acpxAgent: "antigravity" } });
    const transfer = await preparePluginRunnerCredentials({ provider: "antigravity", identity: managed.identity,
      accountIdentity: managed.sessionIdentity, home: join(managed.home!, "provider"), environment: managed.config.env as NodeJS.ProcessEnv });
    await db.insert(environments).values({ id: environmentId, name: `Fixture ${environmentId}`, driver: "plugin", status: "active", config: { pluginKey: pluginId, driverKey: "tasks", driverConfig: {} } });
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "fixture-tasks", version: "1.0.0", status: "ready", manifestJson: {
      capabilities: ["environment.drivers.register"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }],
    } as never });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "manual", status: "running" });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, heartbeatRunId: runId, provider: `plugin:${pluginId}:tasks`, providerLeaseId: "fixture-task", status: "active",
      metadata: { driver: "plugin", pluginId, driverKey: "tasks", runnerTaskLease: true, runnerTaskDispatched: true, runnerTaskExecutionStopped: false } });
    await registerPluginTaskCredentialHandoff(db, { companyId, leaseId }, managed.sessionIdentity, managed.credentialWriteback!);
    await managed.cleanup();
    const calls: string[] = [];
    let exported: unknown = { type: "provider-env", provider: "antigravity", environment: { [SIGN_IN]: signIn("fixture-refreshed", { project_id: "fixture-project" }) } };
    let failExport = false;
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }),
      call: async (_plugin: string, _method: string, params: any) => {
        calls.push(params.operation.kind);
        if (params.operation.kind === "status") return { kind: "status", taskId: "fixture-task", phase: "cancelled", executionStopped: true };
        if (params.operation.kind === "credentials") {
          expect(params.operation.accountIdentity).toBe(managed.sessionIdentity);
          if (failExport) throw new Error("fixture export unavailable");
          return { kind: "credentials", taskId: "fixture-task", credential: exported };
        }
        return { kind: "accepted", taskId: "fixture-task" };
      } } as unknown as PluginWorkerManager;
    const lease = () => db.select().from(environmentLeases).where(and(eq(environmentLeases.id, leaseId), eq(environmentLeases.companyId, companyId))).then(rows => rows[0]!);
    const activity = () => db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    const credential = async () => {
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, managed.credentialWriteback!.grantId));
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, grant!.connectionId));
      return service.credential({ connection: connection!, grant: grant! });
    };
    return { companyId, owner, managed, transfer, calls, lease, activity, credential,
      exportCredential(value: unknown) { exported = value; },
      failExport(value: boolean) { failExport = value; },
      settle: () => settleDispatchedEnvironmentTask(db, workers, { companyId, id: leaseId }) };
  }
  const leaked = (text: string) => ["fixture-original", "fixture-refreshed", "fixture-rotated", "fixture-other", "fixture-client-secret", "fixture-access"]
    .filter(secret => text.includes(secret));

  it("delivers the sanitized saved sign-in and binds writeback to its exact generation", async () => {
    const saved = signIn("fixture-original", { project_id: "fixture-project" });
    const f = await fixture(saved);
    expect(f.transfer).toMatchObject({ needsWriteback: true, credential: { type: "provider-env", provider: "antigravity", environment: { [SIGN_IN]: saved } } });
    expect(f.managed.credentialWriteback).toMatchObject({ google: { credentialSha256: createHash("sha256").update(saved).digest("hex") } });
    expect(leaked(JSON.stringify((await f.lease()).metadata))).toEqual([]);
  });

  it("saves a rotated refresh token for the same Google account and records it without the token", async () => {
    const f = await fixture();
    expect(await f.settle()).toBe("completed");
    expect(f.calls).toEqual(["stop", "status", "credentials", "complete"]);
    expect(await f.credential()).toBe(signIn("fixture-refreshed", { project_id: "fixture-project" }));
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete", outcome: "rotated" });
    const activity = await f.activity();
    expect(activity.map(row => row.action)).toContain("ai_connection.credential_refreshed");
    expect(leaked(JSON.stringify(activity))).toEqual([]);
    expect(leaked(JSON.stringify((await f.lease()).metadata))).toEqual([]);
  });

  it("saves the newest token when Google rotates it again during the account check", async () => {
    const f = await fixture();
    google.rotate = "fixture-rotated";
    expect(await f.settle()).toBe("completed");
    expect(await f.credential()).toBe(signIn("fixture-rotated", { project_id: "fixture-project" }));
  });

  it("refuses a refresh from a different Google account and records why in plain words", async () => {
    const f = await fixture();
    google.email = "mallory@example.test";
    f.exportCredential({ type: "provider-env", provider: "antigravity", environment: { [SIGN_IN]: signIn("fixture-other") } });
    expect(await f.settle()).toBe("completed");
    expect(await f.credential()).toBe(signIn("fixture-original", { project_id: "fixture-project" }));
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete", outcome: "account_refused" });
    const refused = (await f.activity()).find(row => row.action === "ai_connection.credential_refresh_refused");
    expect(refused?.details).toMatchObject({ provider: "google",
      reason: "The refreshed Google sign-in belongs to a different Google account than this connection, so it was not saved." });
    expect(leaked(JSON.stringify(await f.activity()))).toEqual([]);
    expect(JSON.stringify(await f.activity())).not.toContain("mallory@example.test");
  });

  it("does not call Google or rotate when the token is unchanged", async () => {
    const f = await fixture();
    f.exportCredential({ type: "provider-env", provider: "antigravity", environment: { [SIGN_IN]: signIn("fixture-original", { project_id: "fixture-project" }) } });
    expect(await f.settle()).toBe("completed");
    expect(google.calls).toBe(0);
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete", outcome: "unchanged" });
  });

  it("discards a writeback from an older generation after reconnect, without exporting it", async () => {
    const f = await fixture();
    await secretService(db).rotate(f.managed.credentialWriteback!.secretId, { value: signIn("fixture-reconnected") }, { userId: f.owner });
    expect(await f.settle()).toBe("completed");
    expect(f.calls).not.toContain("credentials");
    expect(await f.credential()).toBe(signIn("fixture-reconnected"));
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete", outcome: "binding_changed" });
  });

  it("discards a writeback after the connection is revoked", async () => {
    const f = await fixture();
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, f.managed.credentialWriteback!.grantId));
    expect(await f.settle()).toBe("completed");
    expect(f.calls).not.toContain("credentials");
    expect(google.calls).toBe(0);
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "complete", outcome: "binding_changed" });
  });

  it("keeps the handoff pending when Google cannot confirm the account, then saves on the next cleanup", async () => {
    const f = await fixture();
    google.fail = true;
    const failed = await f.settle().catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(leaked((failed as Error).message)).toEqual([]);
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "pending" });
    expect(await f.credential()).toBe(signIn("fixture-original", { project_id: "fixture-project" }));
    google.fail = false;
    expect(await f.settle()).toBe("completed");
    expect(await f.credential()).toBe(signIn("fixture-refreshed", { project_id: "fixture-project" }));
  });

  it("keeps the handoff pending when the saved sign-in cannot be read, then saves on the next cleanup", async () => {
    const f = await fixture();
    secretRead.fail = true;
    const failed = await f.settle().catch((error: Error) => error).finally(() => { secretRead.fail = false; });
    expect(failed).toBeInstanceOf(Error);
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "pending" });
    expect(await f.settle()).toBe("completed");
    expect(await f.credential()).toBe(signIn("fixture-refreshed", { project_id: "fixture-project" }));
  });

  it.each([
    ["a Codex credential", { type: "codex-auth-json", authJson: "{\"tokens\":{}}" }],
    ["a Gemini API key", { type: "provider-env", provider: "antigravity", environment: { GEMINI_API_KEY: "fixture-gemini" } }],
    ["an invalid sign-in", { type: "provider-env", provider: "antigravity", environment: { [SIGN_IN]: "{\"refresh_token\":\"fixture-refreshed\"}" } }],
  ])("refuses %s as a Google sign-in snapshot without saving or echoing it", async (_name, snapshot) => {
    const f = await fixture();
    f.exportCredential(snapshot);
    const failed = await f.settle().catch((error: Error) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(leaked(String(failed))).toEqual([]);
    expect(await f.credential()).toBe(signIn("fixture-original", { project_id: "fixture-project" }));
    expect((await f.lease()).metadata?.runnerTaskCredentialHandoff).toMatchObject({ state: "pending" });
  });
});
