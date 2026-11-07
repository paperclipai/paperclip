import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Express } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, authUsers, checkpointDb, closeRegisteredClients,
  companies, createDb, fileStorageDb, heartbeatRuns, livenessDb, mcpOauthGrants,
  museAgentBindings, museMailboxItems, museReceiverContactBuckets, subscribeDatabaseWork } from "@paperclipai/db";
import { MUSE_OAUTH_SCOPES, MUSE_RESOURCE_PATH } from "@paperclipai/shared";
import { resolveExternalTestDatabaseUrl } from "../lib/dedicated-test-database-url.js";
import { accessService } from "../services/access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { migrateCloudConfiguration } from "../services/cloud-configuration-migration.js";
import { initializeAdapterSettings } from "../services/adapter-settings.js";
import { initializeCloudRuntimeConfig } from "../services/cloud-runtime-config.js";
import { setCloudRuntimeConfigSnapshot } from "../services/cloud-runtime-config-snapshot.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { museRunnerBroker } from "../services/muse-runner-broker.js";
import { getTaskDrainStatus } from "../services/heartbeat.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { removeTestHome } from "./remove-test-home.js";

const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_MUSE_CONTACT_NORMAL_TEST_DATABASE_URL");
const origin = "https://muse-contact.paperclip.test";
const host = new URL(origin).host;
const resource = origin + MUSE_RESOURCE_PATH;
const redirect = "https://muse-contact-client.example.test/oauth/callback";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const pairingSchema = z.object({ bindingId: z.uuid(), generation: z.number().int().positive(), ticket: z.string().min(20) });
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) });
const mailboxSchema = z.object({ bindingId: z.uuid(), generation: z.number().int().positive(),
  items: z.array(z.object({ id: z.number().int(), kind: z.string(), references: z.object({ nonce: z.string() }).passthrough() })),
  nextCursor: z.number().int() });

describe.skipIf(!databaseUrl)("normal Muse contact verification failure, durable retry and owner reconstruction", () => {
  let db: ReturnType<typeof createDb> | undefined;
  let app: Express | undefined;
  let home: string | undefined;
  let artifactPath: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let restoreVerify: (() => void) | undefined;
  let passed = false;
  let registeredClientsClosed = false;
  let stage = "not-started";
  let queryCount = 0;
  const poolQueryCounts = { main: 0, liveness: 0, checkpoint: 0, fileStorage: 0 };
  let callbacks = 0;
  let sessions = 0;
  let verifyCalls = 0;
  let unexpectedDecisionWakes = 0;
  let invitationFailure: { status: number; code: string; message: string } | undefined;
  let oldOwnerFailures = 0;
  let reconstructedCommits = 0;
  let firstAttemptAt: number | undefined;
  let retryObservedAt: number | undefined;
  let attemptOverflow = 0;
  const attempts: Array<{ owner: "original" | "reconstructed"; atMs: number; outcome: "injected-failure" | "committed" | "error" }> = [];
  const userId = randomUUID(), companyId = randomUUID();
  let agentId: string | undefined;
  let bindingId: string | undefined;
  let generation: number | undefined;
  let clientId: string | undefined;
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let grantId: string | undefined;
  let firstFailureState: { contactPersisted: boolean; challengeAbsent: boolean; mailboxCount: number } | undefined;

  function classifyInvitationFailure(status: number, body: unknown) {
    const parsed = z.object({ error: z.string().optional() }).safeParse(body);
    const fixed = [
      { message: "Board access required", code: "board_access_required" },
      { message: "User does not have access to this company", code: "company_access_denied" },
      { message: "User does not have active company access", code: "active_company_access_required" },
      { message: "Viewer access is read-only", code: "viewer_read_only" },
      { message: "Sign in as a company operator to configure Muse.", code: "company_operator_required" },
      { message: "Missing permission: agents:create.", code: "agents_create_permission_missing" },
      { message: "Permission agents:create does not cover the requested scope.", code: "agents_create_scope_denied" },
      { message: "Enable Muse and Paperclip Runner in experimental settings.", code: "muse_runner_disabled" },
    ].find(value => parsed.success && value.message === parsed.data.error);
    return fixed ? { status, ...fixed }
      : { status, code: "unclassified_invitation_response", message: "Invitation response details withheld" };
  }

  function currentDb() { if (!db) throw new Error("Missing owned Muse database"); return db; }
  function currentApp() { if (!app) throw new Error("Missing normal Muse App"); return app; }
  function record(owner: "original" | "reconstructed", outcome: "injected-failure" | "committed" | "error") {
    const at = performance.now();
    firstAttemptAt ??= at;
    if (attempts.length < 16) attempts.push({ owner, atMs: at - firstAttemptAt, outcome });
    else attemptOverflow++;
  }
  async function openNormalApp(observeBroker?: (owner: ReturnType<typeof createDb>) => void) {
    if (!databaseUrl || !home) throw new Error("Explicit owned Muse fixture inputs required");
    const owner = createDb(databaseUrl, { maxConnections: 2, applicationName: "muse-contact-normal-app" });
    db = owner;
    registeredClientsClosed = false;
    for (const [name, pool] of [["main", owner], ["liveness", livenessDb(owner)],
      ["checkpoint", checkpointDb(owner)], ["fileStorage", fileStorageDb(owner)]] as const) {
      pool.$client.options.debug = () => { queryCount++; poolQueryCounts[name]++; };
    }
    unsubscribe = subscribeDatabaseWork(owner, DELIVERY_QUEUES.museMaintenance, () => { callbacks++; });
    await migrateCloudConfiguration(owner);
    await initializeAdapterSettings(owner);
    await initializeCloudRuntimeConfig(owner);
    observeBroker?.(owner);
    const { createApp } = await import("../app.js");
    app = await createApp(owner, {
      uiMode: "none", serverPort: 3100,
      storageService: createStorageService(createLocalDiskStorageProvider(path.join(home, "objects"))),
      deploymentMode: "authenticated", deploymentExposure: "private", bindHost: "127.0.0.1",
      allowedHostnames: [host], authPublicBaseUrl: origin, authReady: true,
      companyDeletionEnabled: false, managedPluginAutoInstall: [],
      decisionServiceOptions: { wakeOriginAgent: async () => {
        unexpectedDecisionWakes++;
        throw new Error("This Muse contact fixture does not admit Decision continuation work");
      } },
      resolveSession: async req => {
        sessions++;
        if (req.get("x-muse-test-operator") !== userId) return null;
        const [user] = await owner.select().from(authUsers).where(eq(authUsers.id, userId));
        return user ? { session: { id: "muse-contact-normal-session", userId }, user } : null;
      },
    });
    await app.locals.bundledPluginsStartup;
  }
  async function closeNormalApp() {
    if (app) { await app.locals.paperclipShutdown(); app = undefined; }
    restoreVerify?.(); restoreVerify = undefined;
    unsubscribe?.(); unsubscribe = undefined;
    if (db) { await db.$client.end({ timeout: 1 }); db = undefined; }
    if (databaseUrl) {
      await closeRegisteredClients(databaseUrl, { scope: "database" });
      registeredClientsClosed = true;
    }
  }

  beforeAll(async () => {
    const output = process.env.PAPERCLIP_MUSE_CONTACT_ACCEPTANCE_PATH;
    if (!output || !path.isAbsolute(output)) throw new Error("Explicit absolute owned Muse acceptance artifact required");
    artifactPath = output;
    expect(process.env.PAPERCLIP_CLOUD_STACK_ID).toBeUndefined();
    home = await mkdtemp(path.join(tmpdir(), "muse-contact-normal-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_CONFIG", path.join(home, "runtime-config.json"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", origin);
    vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", origin);
    vi.stubEnv("PAPERCLIP_API_URL", origin);
    if (!databaseUrl) throw new Error("Explicit Muse test database required");
    await openNormalApp();
    const owner = currentDb();
    await owner.insert(companies).values({ id: companyId, name: "Muse contact recovery", issuePrefix: "MCR0", requireBoardApprovalForNewAgents: false });
    await owner.insert(authUsers).values({ id: userId, name: "Muse fixture operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await accessService(owner).ensureMembership(companyId, "user", userId, "owner", "active");
    await accessService(owner).ensureRoleDefaultGrants(companyId, userId, "owner", userId);
    await instanceSettingsService(owner).updateExperimental({ enableMuse: true, enableNativeRunner: true });
  }, 90_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    try { await closeNormalApp(); } catch (error) { errors.push(error); }
    if (!errors.length && passed && home) {
      try { removeTestHome(home); } catch (error) { errors.push(error); }
    }
    setCloudRuntimeConfigSnapshot(null);
    vi.unstubAllEnvs();
    if (artifactPath) {
      try { await writeFile(artifactPath + ".cleanup.json", JSON.stringify({ stage, passed,
        oldOwnerFailures, reconstructedCommits, firstFailureState, invitationFailure, attempts, attemptOverflow,
        queryCount, poolQueryCounts, callbacks, sessions, verifyCalls, unexpectedDecisionWakes, cleanupErrors: errors.length,
        appOwnerJoined: app === undefined, rootDbEnded: db === undefined, registeredClientsClosed,
        retainedHome: passed && !errors.length ? false : home ?? null }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Muse normal App owned cleanup failed");
  }, 30_000);

  it("recovers the sole failed contact verification through normal retry and a new Db owner, then stays quiet", async () => {
    stage = "normal-invitation";
    const invite = await request(currentApp()).post(`/api/companies/${companyId}/muse-invitations`)
      .set("Host", host).set("Origin", origin).set("x-muse-test-operator", userId)
      .send({ name: "Contact recovery Muse", role: "Contact verification regression" });
    if (invite.status !== 200) invitationFailure = classifyInvitationFailure(invite.status, invite.body);
    expect(invite.status, invitationFailure ? JSON.stringify(invitationFailure) : undefined).toBe(200);
    const createdAgentId = z.object({ agent: z.object({ id: z.uuid() }) }).parse(invite.body).agent.id;
    agentId = createdAgentId;
    const pairing = await request(currentApp()).post(`/api/companies/${companyId}/agents/${agentId}/muse-binding`)
      .set("Host", host).set("Origin", origin).set("x-muse-test-operator", userId).send({});
    expect(pairing.status).toBe(201);
    const paired = pairingSchema.parse(pairing.body);
    bindingId = paired.bindingId; generation = paired.generation;
    stage = "normal-oauth";
    const registration = await request(currentApp()).post("/api/muse/v1/oauth/register").set("Host", host)
      .send({ client_name: "Normal Muse contact recovery", redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
    expect(registration.status).toBe(201);
    clientId = z.object({ client_id: z.string().min(1) }).parse(registration.body).client_id;
    const verifier = randomBytes(48).toString("base64url");
    const authorization = await request(currentApp()).get("/api/muse/v1/oauth/authorize").set("Host", host)
      .query({ client_id: clientId, redirect_uri: redirect, response_type: "code", resource,
        scope: MUSE_OAUTH_SCOPES.join(" "), code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", pairing_ticket: paired.ticket, state: "muse-contact-normal-state" });
    expect(authorization.status).toBe(303);
    const codeLocation = new URL(z.string().parse(authorization.headers.location));
    expect(codeLocation.origin + codeLocation.pathname).toBe(redirect);
    expect(codeLocation.searchParams.get("state")).toBe("muse-contact-normal-state");
    const tokens = await request(currentApp()).post("/api/muse/v1/oauth/token").set("Host", host)
      .send({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirect, resource,
        code: codeLocation.searchParams.get("code"), code_verifier: verifier });
    expect(tokens.status).toBe(200);
    const credentials = tokenSchema.parse(tokens.body);
    accessToken = credentials.access_token; refreshToken = credentials.refresh_token;
    const owner = currentDb();
    const [authorized] = await owner.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(authorized).toMatchObject({ companyId, agentId, operatorId: userId, generation: paired.generation,
      status: "connected", receiverContactAt: null, verifiedReplyAt: null, challengeHash: null });
    expect(authorized.pairedAt).not.toBeNull(); expect(authorized.grantId).not.toBeNull();
    grantId = z.uuid().parse(authorized.grantId);
    const [grant] = await owner.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId));
    expect(grant).toMatchObject({ companyId, agentId, userId, clientId, resource, purpose: "agent", revokedAt: null });
    expect(grant.scopes).toEqual([...MUSE_OAUTH_SCOPES]);
    expect((await request(currentApp()).post("/api/muse/v1/pair").set("Host", host).send({})).status).toBe(404);

    stage = "sole-contact-failure";
    const originalBroker = museRunnerBroker(owner);
    const fault = vi.spyOn(originalBroker, "verify").mockImplementation(async (...args) => {
      if (args[2].bindingId !== paired.bindingId) throw new Error("Unexpected Muse verification scope in isolated fixture");
      verifyCalls++; oldOwnerFailures++; record("original", "injected-failure");
      if (oldOwnerFailures === 1) {
        const [saved] = await owner.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
        const existing = await owner.select({ id: museMailboxItems.id }).from(museMailboxItems)
          .where(and(eq(museMailboxItems.bindingId, paired.bindingId), eq(museMailboxItems.kind, "readiness_challenge")));
        firstFailureState = { contactPersisted: saved.receiverContactAt !== null,
          challengeAbsent: saved.challengeHash === null, mailboxCount: existing.length };
      }
      if (oldOwnerFailures >= 2 && firstAttemptAt !== undefined && performance.now() - firstAttemptAt >= 5_000) {
        retryObservedAt ??= performance.now() - firstAttemptAt;
      }
      throw Object.assign(new Error("Injected Muse verification infrastructure failure"), { code: "MUSE_TEST_VERIFICATION_UNAVAILABLE" });
    });
    restoreVerify = () => fault.mockRestore();
    const signal = await request(currentApp()).get("/api/muse/v1/signal").set("Host", host).set("X-Paperclip-Muse-Binding", paired.bindingId);
    expect(signal.status).toBe(200); expect(signal.body.version).toBe(1); expect(signal.body.signal === null).toBe(true);
    await vi.waitFor(() => {
      expect(firstFailureState).toEqual({ contactPersisted: true, challengeAbsent: true, mailboxCount: 0 });
    }, { timeout: 45_000, interval: 25 });
    await vi.waitFor(() => {
      expect(oldOwnerFailures).toBeGreaterThanOrEqual(2);
      expect(retryObservedAt).toBeGreaterThanOrEqual(5_000);
    }, { timeout: 10_000, interval: 25 });
    stage = "durable-retry-observed";
    const [beforeRestart] = await owner.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(beforeRestart).toMatchObject({ generation: paired.generation, grantId, verifiedReplyAt: null, challengeHash: null });
    expect(beforeRestart.receiverContactAt).not.toBeNull();
    const contactsBefore = await owner.select().from(museReceiverContactBuckets).where(eq(museReceiverContactBuckets.bindingId, paired.bindingId));
    expect(contactsBefore).toHaveLength(1);
    expect(contactsBefore[0]).toMatchObject({ contacts: 1, bindingGeneration: paired.generation, incomplete: false });
    expect(contactsBefore[0].timestamps).toHaveLength(1);
    await closeNormalApp();

    stage = "new-db-owner-reconstruction";
    await openNormalApp(reconstructed => {
      const reconstructedBroker = museRunnerBroker(reconstructed);
      expect(reconstructedBroker).not.toBe(originalBroker);
      const realVerify = reconstructedBroker.verify;
      const successful = vi.spyOn(reconstructedBroker, "verify").mockImplementation(async (...args) => {
        verifyCalls++;
        try {
          const result = await realVerify(...args);
          record("reconstructed", "committed"); reconstructedCommits++; return result;
        } catch (error) { record("reconstructed", "error"); throw error; }
      });
      restoreVerify = () => successful.mockRestore();
    });
    const reconstructed = currentDb();
    expect(reconstructed).not.toBe(owner);
    await vi.waitFor(() => { expect(reconstructedCommits).toBe(1); }, { timeout: 15_000, interval: 25 });
    const [recovered] = await reconstructed.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(recovered).toMatchObject({ companyId, agentId, operatorId: userId, generation: paired.generation,
      grantId, status: "connected", verifiedReplyAt: null, revision: beforeRestart.revision + 1 });
    expect(recovered.pairedAt).toEqual(beforeRestart.pairedAt);
    expect(recovered.receiverContactAt).toEqual(beforeRestart.receiverContactAt);
    expect(recovered.challengeHash).not.toBeNull();
    if (!recovered.challengeExpiresAt) throw new Error("Real Muse verification did not persist its challenge deadline");
    expect(recovered.challengeExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await reconstructed.select().from(museReceiverContactBuckets).where(eq(museReceiverContactBuckets.bindingId, paired.bindingId))).toEqual(contactsBefore);
    const challengeRows = await reconstructed.select().from(museMailboxItems).where(and(
      eq(museMailboxItems.bindingId, paired.bindingId), eq(museMailboxItems.kind, "readiness_challenge")));
    expect(challengeRows.length).toBe(1);
    expect({ companyId: challengeRows[0].companyId, bindingGeneration: challengeRows[0].bindingGeneration,
      assignmentId: challengeRows[0].assignmentId }).toEqual({ companyId, bindingGeneration: paired.generation, assignmentId: null });
    expect(await reconstructed.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityId, createdAgentId), eq(activityLog.action, "muse.readiness_challenge_created")))).toHaveLength(1);
    stage = "genuine-challenge-confirmation";
    const inbox = await request(currentApp()).post("/api/muse/v1/queries").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, query: "mailbox", after: 0 });
    expect(inbox.status).toBe(200);
    const mailbox = mailboxSchema.parse(inbox.body);
    expect({ bindingId: mailbox.bindingId, generation: mailbox.generation }).toEqual({ bindingId: paired.bindingId, generation: paired.generation });
    expect(mailbox.items.length).toBe(1);
    expect(mailbox.items[0].kind).toBe("readiness_challenge");
    const confirm = await request(currentApp()).post("/api/muse/v1/commands").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, command: "challenge.confirm", nonce: mailbox.items[0].references.nonce, requestId: randomUUID() });
    expect(confirm.status).toBe(200);
    const confirmed = z.object({ status: z.literal("ready"), bindingId: z.uuid(), generation: z.number().int().positive() }).parse(confirm.body);
    expect(confirmed).toEqual({ status: "ready", bindingId: paired.bindingId, generation: paired.generation });
    const acknowledge = await request(currentApp()).post("/api/muse/v1/queries").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, query: "mailbox", after: mailbox.nextCursor });
    expect(acknowledge.status).toBe(200); expect(z.array(z.unknown()).parse(acknowledge.body.items).length).toBe(0);
    await vi.waitFor(async () => {
      const [agent] = await reconstructed.select().from(agents).where(eq(agents.id, createdAgentId));
      expect(agent.lifecycleState).toBe("ready");
      expect(getTaskDrainStatus()).toMatchObject({ activeRuns: 0, pendingWakes: 0, quiescent: true });
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 15_000, interval: 25 });
    const beforeRequiredRead = { total: queryCount, main: poolQueryCounts.main };
    expect(await reconstructed.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    const afterRequiredRead = { total: queryCount, main: poolQueryCounts.main };
    expect(afterRequiredRead.total).toBeGreaterThan(beforeRequiredRead.total);
    expect(afterRequiredRead.main).toBeGreaterThan(beforeRequiredRead.main);
    expect(poolQueryCounts.fileStorage).toBeGreaterThan(0);
    expect(unexpectedDecisionWakes).toBe(0);
    const quietBefore = { queryCount, poolQueryCounts: { ...poolQueryCounts }, callbacks, sessions, verifyCalls, unexpectedDecisionWakes };
    stage = "strict-fifteen-second-quiet";
    const quietStarted = performance.now();
    await pause(15_000);
    const quietElapsedMs = performance.now() - quietStarted;
    const quietAfter = { queryCount, poolQueryCounts: { ...poolQueryCounts }, callbacks, sessions, verifyCalls, unexpectedDecisionWakes };
    expect(quietAfter).toEqual(quietBefore);
    stage = "revocation-and-negatives";
    const revoke = await request(currentApp()).post("/api/muse/v1/oauth/revoke").set("Host", host)
      .send({ client_id: clientId, resource, token: refreshToken });
    expect(revoke.status).toBe(200);
    expect((await request(currentApp()).post("/api/muse/v1/queries").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, query: "mailbox", after: mailbox.nextCursor })).status).toBe(401);
    expect((await request(currentApp()).get("/api/muse/v1/signal").set("Host", host).set("X-Paperclip-Muse-Binding", paired.bindingId)).status).toBe(410);
    const [revokedGrant] = await reconstructed.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId));
    expect(revokedGrant.revokedAt).not.toBeNull();
    const [finalBinding] = await reconstructed.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(finalBinding.revokedAt).not.toBeNull(); expect(finalBinding.verifiedReplyAt).not.toBeNull();
    expect(unexpectedDecisionWakes).toBe(0);
    if (!artifactPath) throw new Error("Missing owned Muse acceptance path");
    await writeFile(artifactPath, JSON.stringify({ contract: "normal Muse contact verification recovery",
      companyId, userId, agentId, bindingId, generation, clientId, grantId, normalOAuth: true,
      receiverSignals: 1, oldOwnerFailures, retryObservedAtMs: retryObservedAt, firstFailureState,
      reconstructedDbObject: true, challengeCount: challengeRows.length, challengeConfirmed: true,
      contacts: contactsBefore[0].contacts, contactTimestampCount: contactsBefore[0].timestamps.length,
      beforeRestartRevision: beforeRestart.revision, recoveredRevision: recovered.revision,
      queryInstrumentation: { beforeRequiredRead, afterRequiredRead }, unexpectedDecisionWakes,
      quiet: { elapsedMs: quietElapsedMs, before: quietBefore, after: quietAfter },
      revoked: true, oldAccessRejected: true, oldSignalRejected: true, nativeRuns: 0,
      cost: null, usage: null, liveMuseBackgroundReply: false,
      attempts, attemptOverflow }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    stage = "complete"; passed = true;
  }, 90_000);
});
