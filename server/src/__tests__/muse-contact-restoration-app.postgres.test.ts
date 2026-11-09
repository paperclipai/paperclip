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
import { parseMuseVerificationHint } from "../modules/external-agents/index.js";
import { HttpError } from "../errors.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { removeTestHome } from "./remove-test-home.js";

const databaseUrl = resolveExternalTestDatabaseUrl("PAPERCLIP_MUSE_CONTACT_NORMAL_TEST_DATABASE_URL");
const origin = "https://muse-restoration.paperclip.test";
const host = new URL(origin).host;
const resource = origin + MUSE_RESOURCE_PATH;
const redirect = "https://muse-restoration-client.example.test/oauth/callback";
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const pairingSchema = z.object({ bindingId: z.uuid(), generation: z.number().int().positive(), ticket: z.string().min(20) });
const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1) });
const mailboxSchema = z.object({ bindingId: z.uuid(), generation: z.number().int().positive(),
  items: z.array(z.object({ id: z.number().int(), kind: z.string(), references: z.object({ nonce: z.string() }).passthrough() })),
  nextCursor: z.number().int() });

describe.skipIf(!databaseUrl).each(["permission", "lifecycle"] as const)("normal Muse %s restoration", mode => {
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
  const userId = randomUUID(), restorerId = randomUUID(), companyId = randomUUID();
  let contactSettled = 0;
  let deniedVerifications = 0;
  let committedVerifications = 0;
  let otherVerifyCalls = 0;
  let otherDeniedVerifications = 0;
  let otherCommittedVerifications = 0;
  let expectedResumeState: string | undefined;
  let agentId: string | undefined;
  let bindingId: string | undefined;
  let generation: number | undefined;
  let clientId: string | undefined;
  let accessToken: string | undefined;
  let refreshToken: string | undefined;
  let grantId: string | undefined;

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
  async function openNormalApp(observeBroker?: (owner: ReturnType<typeof createDb>) => void) {
    if (!databaseUrl || !home) throw new Error("Explicit owned Muse fixture inputs required");
    const owner = createDb(databaseUrl, { maxConnections: 2, applicationName: "muse-contact-normal-app" });
    db = owner;
    registeredClientsClosed = false;
    for (const [name, pool] of [["main", owner], ["liveness", livenessDb(owner)],
      ["checkpoint", checkpointDb(owner)], ["fileStorage", fileStorageDb(owner)]] as const) {
      pool.$client.options.debug = () => { queryCount++; poolQueryCounts[name]++; };
    }
    unsubscribe = subscribeDatabaseWork(owner, DELIVERY_QUEUES.museMaintenance, (event, hints) => {
      callbacks++;
      if (event === "settled" && Array.from(hints ?? []).some(raw => {
        const hint = parseMuseVerificationHint(raw);
        return hint !== undefined && hint.bindingId === bindingId && hint.generation === generation && hint.companyId === companyId;
      })) contactSettled++;
    });
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
        const sessionUserId = req.get("x-muse-test-operator");
        if (sessionUserId !== userId && sessionUserId !== restorerId) return null;
        const [user] = await owner.select().from(authUsers).where(eq(authUsers.id, sessionUserId));
        return user ? { session: { id: "muse-restoration-session-" + sessionUserId, userId: sessionUserId }, user } : null;
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
    await owner.insert(companies).values({ id: companyId, name: "Muse contact recovery", issuePrefix: mode === "permission" ? "MRP0" : "MRL0", requireBoardApprovalForNewAgents: false });
    await owner.insert(authUsers).values({ id: userId, name: "Muse fixture operator", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await accessService(owner).ensureMembership(companyId, "user", userId, "operator", "active");
    await accessService(owner).ensureRoleDefaultGrants(companyId, userId, "operator", userId);
    await owner.insert(authUsers).values({ id: restorerId, name: "Restoration owner", email: restorerId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await accessService(owner).ensureMembership(companyId, "user", restorerId, "owner", "active");
    await accessService(owner).ensureRoleDefaultGrants(companyId, restorerId, "owner", restorerId);
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
      try { await writeFile(artifactPath + "." + mode + ".cleanup.json", JSON.stringify({ stage, passed,
        mode, deniedVerifications, committedVerifications, otherVerifyCalls, otherDeniedVerifications, otherCommittedVerifications, contactSettled, expectedResumeState, invitationFailure,
        queryCount, poolQueryCounts, callbacks, sessions, verifyCalls, unexpectedDecisionWakes, cleanupErrors: errors.length,
        appOwnerJoined: app === undefined, rootDbEnded: db === undefined, registeredClientsClosed,
        retainedHome: passed && !errors.length ? false : home ?? null }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
      catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Muse normal App owned cleanup failed");
  }, 30_000);

  it("restores the same current binding without another contact or manual verification, then remains quiet and revoked", async () => {
    stage = "normal-invitation";
    const invite = await request(currentApp()).post(`/api/companies/${companyId}/muse-invitations`)
      .set("Host", host).set("Origin", origin).set("x-muse-test-operator", restorerId)
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

    stage = "sole-contact-before-parking";
    const broker = museRunnerBroker(owner);
    const realVerify = broker.verify;
    const observed = vi.spyOn(broker, "verify").mockImplementation(async (...args) => {
      verifyCalls++;
      const current = args[0] === companyId && args[1] === createdAgentId
        && args[2].bindingId === paired.bindingId && args[2].generation === paired.generation;
      if (!current) otherVerifyCalls++;
      try {
        const result = await realVerify(...args);
        if (current) committedVerifications++;
        else otherCommittedVerifications++;
        return result;
      } catch (error) {
        if (error instanceof HttpError && error.status === 403) {
          if (current) deniedVerifications++;
          else otherDeniedVerifications++;
        }
        throw error;
      }
    });
    restoreVerify = () => observed.mockRestore();
    const signal = await request(currentApp()).get("/api/muse/v1/signal").set("Host", host).set("X-Paperclip-Muse-Binding", paired.bindingId);
    expect(signal.status).toBe(200); expect(signal.body.version).toBe(1); expect(signal.body.signal).toBeNull();
    const member = await accessService(owner).getMembership(companyId, "user", userId);
    if (!member) throw new Error("Missing normally authorized Muse operator membership");
    if (mode === "permission") {
      const demote = await request(currentApp()).patch(`/api/companies/${companyId}/members/${member.id}`)
        .set("Host", host).set("Origin", origin).set("x-muse-test-operator", restorerId)
        .send({ membershipRole: "viewer", status: "active" });
      expect(demote.status).toBe(200);
      expect(demote.body).toMatchObject({ principalId: userId, membershipRole: "viewer", status: "active" });
    } else {
      const pauseAgent = await request(currentApp()).post(`/api/agents/${createdAgentId}/pause`)
        .set("Host", host).set("Origin", origin).set("x-muse-test-operator", restorerId).send({});
      expect(pauseAgent.status).toBe(200);
    }
    // Wait only on the real commit-bound contact notification; no flush/Verify kick.
    await vi.waitFor(() => { expect(contactSettled).toBeGreaterThan(0); }, { timeout: 45_000, interval: 25 });
    if (mode === "permission") {
      await vi.waitFor(() => { expect(deniedVerifications).toBeGreaterThan(0); }, { timeout: 10_000, interval: 25 });
    }
    async function settled() {
      await vi.waitFor(() => {
        expect(getTaskDrainStatus()).toMatchObject({ activeRuns: 0, pendingWakes: 0, quiescent: true });
        expect(idleWorkSnapshot().active).toBe(0);
      }, { timeout: 15_000, interval: 25 });
    }
    const counters = () => ({ queryCount, pools: { ...poolQueryCounts }, callbacks, sessions, verifyCalls, unexpectedDecisionWakes });
    async function quiet() {
      await settled();
      const beforeRequiredRead = { total: queryCount, main: poolQueryCounts.main };
      expect(await owner.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
      expect(queryCount).toBeGreaterThan(beforeRequiredRead.total);
      expect(poolQueryCounts.main).toBeGreaterThan(beforeRequiredRead.main);
      expect(poolQueryCounts.fileStorage).toBeGreaterThan(0);
      const before = counters(), at = performance.now();
      await pause(15_000);
      const elapsedMs = performance.now() - at, after = counters();
      expect(after).toEqual(before);
      return { before, after, elapsedMs, positiveReadControl: true };
    }
    await settled();
    const [parked] = await owner.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(parked).toMatchObject({ companyId, agentId, operatorId: userId, generation: paired.generation,
      grantId, status: "connected", challengeHash: null, verifiedReplyAt: null, revokedAt: null });
    expect(parked.receiverContactAt).not.toBeNull();
    const [parkedGrant] = await owner.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId));
    expect(parkedGrant).toMatchObject({ userId, companyId, agentId, clientId, revokedAt: null });
    const contactsBefore = await owner.select().from(museReceiverContactBuckets).where(eq(museReceiverContactBuckets.bindingId, paired.bindingId));
    expect(contactsBefore).toHaveLength(1); expect(contactsBefore[0]).toMatchObject({ contacts: 1, bindingGeneration: paired.generation, incomplete: false });
    expect(contactsBefore[0].timestamps).toHaveLength(1); expect(committedVerifications).toBe(0);
    if (mode === "lifecycle") {
      const [pausedAgent] = await owner.select().from(agents).where(eq(agents.id, createdAgentId));
      expect(pausedAgent).toMatchObject({ status: "paused", lifecycleState: "paused" });
      expect(pausedAgent.lifecycleHolds).not.toContain("setup");
      expectedResumeState = pausedAgent.lifecycleOperation?.resumeState;
      expect(["preparing", "verifying"]).toContain(expectedResumeState);
      // A snapshot taken before Pause can reach the real verifier and be denied.
      // The strict window below still accounts for ALL owner-wide calls.
      expect(otherCommittedVerifications).toBe(0);
    }
    stage = "parked-current-binding";
    const parkedQuiet = await quiet();
    stage = "normal-authorized-restoration";
    if (mode === "permission") {
      const restore = await request(currentApp()).patch(`/api/companies/${companyId}/members/${member.id}`)
        .set("Host", host).set("Origin", origin).set("x-muse-test-operator", restorerId)
        .send({ membershipRole: "operator", status: "active" });
      expect(restore.status).toBe(200);
      expect(restore.body).toMatchObject({ principalId: userId, membershipRole: "operator", status: "active" });
    } else {
      const resume = await request(currentApp()).post(`/api/agents/${createdAgentId}/resume`)
        .set("Host", host).set("Origin", origin).set("x-muse-test-operator", restorerId).send({});
      expect(resume.status).toBe(200); expect(resume.body.status).toBe("paused");
    }
    await vi.waitFor(() => { expect(committedVerifications).toBe(1); }, { timeout: 15_000, interval: 25 });
    const [recovered] = await owner.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(recovered).toMatchObject({ companyId, agentId, operatorId: userId, generation: paired.generation,
      grantId, status: "connected", revision: parked.revision + 1, verifiedReplyAt: null, revokedAt: null });
    expect(recovered.pairedAt).toEqual(parked.pairedAt); expect(recovered.receiverContactAt).toEqual(parked.receiverContactAt);
    expect(recovered.challengeHash).not.toBeNull();
    expect(await owner.select().from(museReceiverContactBuckets).where(eq(museReceiverContactBuckets.bindingId, paired.bindingId))).toEqual(contactsBefore);
    const challengeRows = await owner.select().from(museMailboxItems).where(and(
      eq(museMailboxItems.bindingId, paired.bindingId), eq(museMailboxItems.kind, "readiness_challenge")));
    expect(challengeRows).toHaveLength(1);
    expect(challengeRows[0]).toMatchObject({ companyId, bindingGeneration: paired.generation, assignmentId: null });
    expect(await owner.select({ id: activityLog.id }).from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.entityId, createdAgentId), eq(activityLog.action, "muse.readiness_challenge_created")))).toHaveLength(1);
    const [restoredAgent] = await owner.select().from(agents).where(eq(agents.id, createdAgentId));
    expect(restoredAgent.status).toBe("paused");
    expect(["preparing", "verifying"]).toContain(restoredAgent.lifecycleState);
    const inbox = await request(currentApp()).post("/api/muse/v1/queries").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, query: "mailbox", after: 0 });
    expect(inbox.status).toBe(200);
    const mailbox = mailboxSchema.parse(inbox.body);
    expect(mailbox).toMatchObject({ bindingId: paired.bindingId, generation: paired.generation });
    expect(mailbox.items).toHaveLength(1); expect(mailbox.items[0].kind).toBe("readiness_challenge");
    const confirm = await request(currentApp()).post("/api/muse/v1/commands").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, command: "challenge.confirm", nonce: mailbox.items[0].references.nonce, requestId: randomUUID() });
    expect(confirm.status).toBe(200); expect(confirm.body).toMatchObject({ status: "ready", bindingId: paired.bindingId, generation: paired.generation });
    const acknowledge = await request(currentApp()).post("/api/muse/v1/queries").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, query: "mailbox", after: mailbox.nextCursor });
    expect(acknowledge.status).toBe(200); expect(acknowledge.body.items).toEqual([]);
    await vi.waitFor(async () => {
      const [ready] = await owner.select().from(agents).where(eq(agents.id, createdAgentId));
      expect(ready.lifecycleState).toBe("ready");
    }, { timeout: 15_000, interval: 25 });
    stage = "restored-ready-quiet";
    const restoredQuiet = await quiet();
    const revoke = await request(currentApp()).post("/api/muse/v1/oauth/revoke").set("Host", host)
      .send({ client_id: clientId, token: refreshToken, resource });
    expect(revoke.status).toBe(200);
    expect((await request(currentApp()).post("/api/muse/v1/queries").set("Host", host).set("Authorization", "Bearer " + accessToken)
      .send({ version: 1, query: "mailbox", after: 0 })).status).toBe(401);
    expect((await request(currentApp()).get("/api/muse/v1/signal").set("Host", host).set("X-Paperclip-Muse-Binding", paired.bindingId)).status).toBe(410);
    await instanceSettingsService(owner).updateExperimental({ enableMuse: false });
    stage = "revoked-and-disabled-quiet";
    const revokedDisabledQuiet = await quiet();
    const [finalGrant] = await owner.select().from(mcpOauthGrants).where(eq(mcpOauthGrants.id, grantId));
    const [finalBinding] = await owner.select().from(museAgentBindings).where(eq(museAgentBindings.id, paired.bindingId));
    expect(finalGrant.revokedAt).not.toBeNull(); expect(finalBinding.revokedAt).not.toBeNull();
    expect(committedVerifications).toBe(1); expect(unexpectedDecisionWakes).toBe(0);
    if (!artifactPath) throw new Error("Missing owned restoration evidence path");
    await writeFile(artifactPath + "." + mode + ".json", JSON.stringify({ mode, companyId, userId, restorerId,
      agentId, bindingId, generation, grantId, receiverSignals: 1, contacts: 1, timestampCount: 1,
      parkedRevision: parked.revision, recoveredRevision: recovered.revision, expectedResumeState,
      actualRestoredLifecycle: restoredAgent.lifecycleState, compatibilityStatusUnchanged: true,
      normalOAuth: true, deniedVerifications, committedVerifications, otherVerifyCalls, otherDeniedVerifications, otherCommittedVerifications, noManualVerify: true,
      parkedQuiet, restoredQuiet, revokedDisabledQuiet, nativeRuns: 0, cost: null, usage: null,
      liveMuseBackgroundReply: false, revoked: true, disabled: true }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    stage = "complete"; passed = true;
  }, 90_000);
});
