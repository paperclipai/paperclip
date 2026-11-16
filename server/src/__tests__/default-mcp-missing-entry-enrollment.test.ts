import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetDefaultMcpTemplateScopeForTests, captureDefaultMcpTemplateScope } from "../secrets/default-mcp-template-scope.js";
import { eq, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, connectionTokenIssuances, createDb, heartbeatRuns, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolMcpGatewayTokens, toolMcpGateways, toolOauthStates, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { DEFAULT_MCP_SPEC, readDefaultMcpState } from "../services/default-mcp-spec.js";
import { snapshotDefaultMcpForNewAgent, waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import {
  MISSING_ENTRY_CONFIRMATION,
  MissingEntryConfirmationError,
  MissingEntryInvalidResponsibleUserError,
  addMissingDefaultMcpEntries,
  missingEntryEligibleSpec,
} from "../services/default-mcp-missing-entry-enrollment.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
} from "../services/comms-board-provisioner-client.js";
import {
  BOARD_ADMIN_TOKEN,
  BOARD_TOKEN,
  BOARD_URL,
  OWNERSHIP_TOKEN,
  OWNERSHIP_URL,
  clearBootProvisionerSnapshot,
  downstreamFetch,
  installBootProvisionerSnapshot,
} from "./helpers/comms-board-downstream.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const TEMPLATE_URL = "https://8.8.8.8/mcp";
const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";

describe("missingEntryEligibleSpec", () => {
  it("is derived from the spec: managed (hook) entries minus arcana-brain", () => {
    const keys = missingEntryEligibleSpec().map((e) => e.key);
    expect(keys).toContain("comms-board");
    expect(keys).not.toContain("arcana-brain");
    expect(keys.every((k) => DEFAULT_MCP_SPEC.find((e) => e.key === k)!.setupHook)).toBe(true);
  });
});

describeEmbeddedPostgres("adding missing managed default-MCP entries to agents that already have a state", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-missing-entry-${randomUUID()}`);
  const envKeys = [FEATURE_ENV, COMMS_BOARD_MCP_URL_ENV, COMMS_BOARD_ADMIN_TOKEN_ENV, COMMS_BOARD_OWNERSHIP_API_URL_ENV, COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-missing-entry");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({});
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    clearBootProvisionerSnapshot();
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(toolMcpGatewayTokens);
    await db.delete(toolMcpGateways);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(principalPermissionGrants);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(status: "active" | "archived" = "active") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status,
    });
    return companyId;
  }

  async function seedOwner(companyId: string) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: "owner@redesignhealth.com", emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    return userId;
  }

  async function seedConnection(companyId: string, name: string, authKind: "oauth" | "api_key" = "oauth") {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app ${name} ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    return db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name,
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind,
        credentialPolicy: authKind === "api_key" ? "shared" : "per_user",
        status: "active",
        enabled: true,
        config: { url: TEMPLATE_URL },
        transportConfig: { url: TEMPLATE_URL },
        credentialRefs: [],
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function seedCommsTemplate(companyId: string) {
    const application = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: `app comms ${randomUUID().slice(0, 4)}`, type: "mcp_http", status: "active" })
      .returning()
      .then((rows) => rows[0]!);
    const shared = await secretService(db).create(companyId, { name: `shared comms ${randomUUID()}`, key: `shared.${randomUUID()}`, provider: "local_encrypted", value: "org-shared-template-token" });
    const connection = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: application.id,
        name: "rh-comms-board",
        uid: `uid-${randomUUID()}`,
        transport: "mcp_remote",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "active",
        enabled: true,
        config: { url: TEMPLATE_URL },
        transportConfig: { url: TEMPLATE_URL },
        credentialRefs: [{ name: "credentials.authorization", secretId: shared.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }],
      })
      .returning()
      .then((rows) => rows[0]!);
    const [entry] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: application.id, connectionId: connection.id, name: "send_note", toolName: "send_note", versionHash: "v1" })
      .returning();
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${connection.id}`, name: "comms access", defaultAction: "deny", metadata: { source: "app_gallery_finish", connectionId: connection.id } })
      .returning();
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", connectionId: connection.id, catalogEntryId: entry!.id });
  }

  function configureDownstream() {
    installBootProvisionerSnapshot({
      [COMMS_BOARD_MCP_URL_ENV]: BOARD_URL,
      [COMMS_BOARD_ADMIN_TOKEN_ENV]: BOARD_ADMIN_TOKEN,
      [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
      [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
    });
  }

  const enableFeature = () => { process.env[FEATURE_ENV] = "true"; };

  /** An existing agent holding a `defaultMcp` state with ONLY the arcana-brain entry (what the Arcana backfill leaves). */
  async function arcanaOnlyAgent(companyId: string, creatorUserId: string | null) {
    delete process.env[FEATURE_ENV];
    const created = await agentService(db).create(
      companyId,
      { name: `Agent ${randomUUID().slice(0, 6)}`, role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: null } },
    );
    if (creatorUserId) {
      await db.insert(activityLog).values({ companyId, actorType: "user", actorId: creatorUserId, action: "agent.created", entityType: "agent", entityId: created.id });
    }
    await snapshotDefaultMcpForNewAgent(db, {
      companyId,
      agentId: created.id,
      ownerUserId: creatorUserId,
      spec: DEFAULT_MCP_SPEC.filter((entry) => entry.key === "arcana-brain"),
    });
    return created;
  }

  const rowOf = async (agentId: string) => (await db.select().from(agents).where(eq(agents.id, agentId)))[0]!;
  const stateOf = async (agentId: string) => readDefaultMcpState((await rowOf(agentId)).metadata)!;
  const outcomeOf = (report: { outcomes: Array<{ agentId: string }> }, agentId: string) => report.outcomes.find((o) => o.agentId === agentId) as Record<string, unknown> | undefined;
  const everything = async () =>
    JSON.stringify([await db.select().from(agents).orderBy(agents.id), await db.select().from(companySecrets).orderBy(companySecrets.id), await db.select().from(connectionGrants).orderBy(connectionGrants.id)]);
  const real = (companyId: string, extra: Record<string, unknown> = {}) =>
    addMissingDefaultMcpEntries(db, { companyId, dryRun: false, confirm: MISSING_ENTRY_CONFIRMATION, ...extra });

  it("a real run without the confirmation string is rejected before anything happens", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await arcanaOnlyAgent(companyId, ownerId);
    enableFeature();
    const before = await everything();
    await expect(addMissingDefaultMcpEntries(db, { companyId, dryRun: false })).rejects.toBeInstanceOf(MissingEntryConfirmationError);
    await expect(addMissingDefaultMcpEntries(db, { companyId, dryRun: false, confirm: "yes" })).rejects.toBeInstanceOf(MissingEntryConfirmationError);
    expect(await everything()).toBe(before);
  });

  it("a dry run (the default) lists the missing keys and writes and calls nothing", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    const agent = await arcanaOnlyAgent(companyId, ownerId);
    enableFeature();
    configureDownstream();
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);
    const before = await everything();

    const report = await addMissingDefaultMcpEntries(db, { companyId });
    await waitForScheduledDefaultMcpSetups();

    expect(report.dryRun).toBe(true);
    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "would_add", keys: ["comms-board"] });
    expect(report.counts.would_add).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("a real run adds only the missing entry, preserves the existing one byte for byte, and runs setup so the credential is minted", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    const agent = await arcanaOnlyAgent(companyId, ownerId);
    const arcanaBefore = JSON.stringify((await stateOf(agent.id)).entries["arcana-brain"]);
    const metadataBefore = (await rowOf(agent.id)).metadata as Record<string, unknown>;
    enableFeature();
    configureDownstream();
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const report = await real(companyId);
    await waitForScheduledDefaultMcpSetups();

    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "added", keys: ["comms-board"] });
    const state = await stateOf(agent.id);
    expect(Object.keys(state.entries).sort()).toEqual(["arcana-brain", "comms-board"]);
    expect(JSON.stringify(state.entries["arcana-brain"])).toBe(arcanaBefore);
    // Other metadata keys are untouched too.
    const metadataAfter = (await rowOf(agent.id)).metadata as Record<string, unknown>;
    expect({ ...metadataAfter, defaultMcp: undefined }).toEqual({ ...metadataBefore, defaultMcp: undefined });
    const comms = state.entries["comms-board"]!;
    expect(comms).toMatchObject({ dedicated: true, enabled: false, ownerUserId: ownerId });
    expect(comms.setup.state).toBe("ready");
    expect(fetchMock.calls.register).toHaveLength(1);
    expect(fetchMock.calls.mint).toHaveLength(1);
    expect(await secretService(db).resolveSecretValue(companyId, comms.binding!.secretId!, "latest")).toBe(BOARD_TOKEN);
    const logged = JSON.stringify(await db.select().from(activityLog));
    expect(logged).toContain("agent.default_mcp.missing_entries_added");
    expect(logged).not.toContain(BOARD_TOKEN);
    expect(JSON.stringify(report)).not.toContain(BOARD_TOKEN);
  });

  it("is idempotent: a second run adds nothing and calls nothing", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await seedCommsTemplate(companyId);
    const agent = await arcanaOnlyAgent(companyId, ownerId);
    enableFeature();
    configureDownstream();
    vi.stubGlobal("fetch", downstreamFetch());
    await real(companyId);
    await waitForScheduledDefaultMcpSetups();
    const before = await everything();
    const fetchMock = downstreamFetch();
    vi.stubGlobal("fetch", fetchMock);

    const second = await real(companyId);
    await waitForScheduledDefaultMcpSetups();

    expect(outcomeOf(second, agent.id)).toMatchObject({ result: "skipped", reason: "nothing_missing" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await everything()).toBe(before);
  });

  it("reports owner_required in both a dry and a real run and changes nothing", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const agent = await arcanaOnlyAgent(companyId, null); // no agent.created evidence
    enableFeature();
    const before = await everything();

    const dry = await addMissingDefaultMcpEntries(db, { companyId });
    const live = await real(companyId);

    expect(outcomeOf(dry, agent.id)).toMatchObject({ result: "skipped", reason: "owner_required" });
    expect(outcomeOf(live, agent.id)).toMatchObject({ result: "skipped", reason: "owner_required" });
    expect(await everything()).toBe(before);
  });

  async function seedUser(companyId: string | null, opts: { verified?: boolean; status?: string } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Dan", email: `${userId}@redesignhealth.com`, emailVerified: opts.verified ?? true, createdAt: now, updatedAt: now });
    if (companyId) await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: opts.status ?? "active", membershipRole: "member" });
    return userId;
  }
  const overrideActivity = async () => (await db.select().from(activityLog)).filter((row) => row.action === "agent.default_mcp.responsible_user_override");

  describe("operator responsibleUserId override", () => {
    it("fills only the agent with no audit-log owner: dry run reports would_add, real run enrolls it and writes one audit entry", async () => {
      const companyId = await seedCompany();
      await seedCommsTemplate(companyId);
      const operator = await seedUser(companyId);
      const target = await seedUser(companyId);
      const agent = await arcanaOnlyAgent(companyId, null);
      enableFeature();
      configureDownstream();
      vi.stubGlobal("fetch", downstreamFetch());
      const before = await everything();

      const dry = await addMissingDefaultMcpEntries(db, { companyId, responsibleUserId: target, actedByUserId: operator });
      expect(outcomeOf(dry, agent.id)).toMatchObject({ result: "would_add", keys: ["comms-board"], responsibleSource: "operator_override" });
      expect(await everything()).toBe(before);
      expect(await overrideActivity()).toHaveLength(0);

      const live = await real(companyId, { responsibleUserId: target, actedByUserId: operator });
      await waitForScheduledDefaultMcpSetups();
      expect(outcomeOf(live, agent.id)).toMatchObject({ result: "added", keys: ["comms-board"], responsibleSource: "operator_override" });
      expect((await stateOf(agent.id)).entries["comms-board"]).toMatchObject({ ownerUserId: target });
      const audit = await overrideActivity();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ companyId, actorType: "user", actorId: operator, entityType: "agent", entityId: agent.id });
      expect(audit[0]!.details).toEqual({ responsibleUserId: target, keys: ["comms-board"] });
      expect(JSON.stringify(audit)).not.toContain(BOARD_TOKEN);
    });

    it("never overrides an agent that already resolves an owner", async () => {
      const companyId = await seedCompany();
      await seedCommsTemplate(companyId);
      const creator = await seedOwner(companyId);
      const operator = await seedUser(companyId);
      const target = await seedUser(companyId);
      const agent = await arcanaOnlyAgent(companyId, creator);
      enableFeature();
      configureDownstream();
      vi.stubGlobal("fetch", downstreamFetch());

      const dry = await addMissingDefaultMcpEntries(db, { companyId, responsibleUserId: target, actedByUserId: operator });
      expect(outcomeOf(dry, agent.id)).toMatchObject({ result: "would_add", responsibleSource: "audit_log" });
      const live = await real(companyId, { responsibleUserId: target, actedByUserId: operator });
      await waitForScheduledDefaultMcpSetups();
      expect(outcomeOf(live, agent.id)).toMatchObject({ result: "added", responsibleSource: "audit_log" });
      expect((await stateOf(agent.id)).entries["comms-board"]).toMatchObject({ ownerUserId: creator });
      expect(await overrideActivity()).toHaveLength(0);
    });

    it("rejects a non-member, unverified, inactive or non-user target for the whole request and changes nothing", async () => {
      const companyId = await seedCompany();
      const otherCompanyId = await seedCompany();
      const operator = await seedUser(companyId);
      const agent = await arcanaOnlyAgent(companyId, null);
      enableFeature();
      const nonMember = await seedUser(otherCompanyId);
      const unverified = await seedUser(companyId, { verified: false });
      const inactive = await seedUser(companyId, { status: "suspended" });
      const principalIsAgent = await seedUser(null);
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: principalIsAgent, status: "active", membershipRole: "member" });
      const before = await everything();

      for (const responsibleUserId of [nonMember, unverified, inactive, principalIsAgent, "does-not-exist"]) {
        await expect(addMissingDefaultMcpEntries(db, { companyId, responsibleUserId, actedByUserId: operator })).rejects.toBeInstanceOf(MissingEntryInvalidResponsibleUserError);
        await expect(real(companyId, { responsibleUserId, actedByUserId: operator })).rejects.toBeInstanceOf(MissingEntryInvalidResponsibleUserError);
      }
      expect(await everything()).toBe(before);
      expect(await overrideActivity()).toHaveLength(0);
      expect(outcomeOf(await addMissingDefaultMcpEntries(db, { companyId }), agent.id)).toMatchObject({ reason: "owner_required" });
    });

    it("without the field behaves as before: owner_required, and audit-log agents report responsibleSource audit_log", async () => {
      const companyId = await seedCompany();
      await seedCommsTemplate(companyId);
      const creator = await seedOwner(companyId);
      const orphan = await arcanaOnlyAgent(companyId, null);
      const owned = await arcanaOnlyAgent(companyId, creator);
      enableFeature();

      const dry = await addMissingDefaultMcpEntries(db, { companyId });
      expect(outcomeOf(dry, orphan.id)).toMatchObject({ result: "skipped", reason: "owner_required" });
      expect(outcomeOf(dry, owned.id)).toMatchObject({ result: "would_add", responsibleSource: "audit_log" });
    });
  });

  it("honours legacy access conflicts", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const agent = await arcanaOnlyAgent(companyId, ownerId);
    const first = await seedConnection(companyId, "rh-google-mcp");
    await seedConnection(companyId, "rh-google-mcp");
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: first.id, targetType: "agent", targetId: agent.id });
    enableFeature();
    const before = await everything();

    const report = await real(companyId);

    expect(outcomeOf(report, agent.id)).toMatchObject({ result: "skipped", reason: "legacy_access_conflict" });
    expect(await everything()).toBe(before);
  });

  it("skips terminated agents, archived and out-of-scope companies, corrupted state and agents with no state; nothing is written", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const terminated = await arcanaOnlyAgent(companyId, ownerId);
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated.id));
    const corrupted = await arcanaOnlyAgent(companyId, ownerId);
    await db.update(agents).set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','version']::text[], '7'::jsonb)` }).where(eq(agents.id, corrupted.id));
    const noState = await agentService(db).create(
      companyId,
      { name: "plain", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, spentMonthlyCents: 0, lastHeartbeatAt: null },
      { claudeLogin: { storedSessionId: null, ownerUserId: null } },
    );
    const archivedCompany = await seedCompany("archived");
    const archivedAgent = await arcanaOnlyAgent(archivedCompany, await seedOwner(archivedCompany));
    const scopedCompany = await seedCompany();
    const scopedAgent = await arcanaOnlyAgent(scopedCompany, await seedOwner(scopedCompany));
    enableFeature();
    const before = await everything();

    const report = await real(companyId);
    expect(outcomeOf(report, terminated.id)).toMatchObject({ reason: "agent_terminated" });
    expect(outcomeOf(report, corrupted.id)).toMatchObject({ reason: "corrupted_existing_state" });
    expect(outcomeOf(report, noState.id)).toMatchObject({ reason: "no_default_mcp_state" });
    const archived = await real(archivedCompany);
    expect(outcomeOf(archived, archivedAgent.id)).toMatchObject({ reason: "company_archived" });
    // Out of rollout scope: freeze a scope that excludes the company.
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ PAPERCLIP_DEFAULT_MCP_TEMPLATE_COMPANY_IDS: randomUUID() });
    const scoped = await real(scopedCompany);
    expect(outcomeOf(scoped, scopedAgent.id)).toMatchObject({ reason: "company_out_of_scope" });
    expect(await everything()).toBe(before);
  });

  it("does nothing while the framework flag is off", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await arcanaOnlyAgent(companyId, ownerId);
    delete process.env[FEATURE_ENV];
    const before = await everything();
    const report = await real(companyId);
    expect(report.blocked).toBe("feature_flag_off");
    expect(report.outcomes).toEqual([]);
    expect(await everything()).toBe(before);
  });

  it("one unusable agent never stops the batch; reports hold ids and keys only", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    const good = await arcanaOnlyAgent(companyId, ownerId);
    const bad = await arcanaOnlyAgent(companyId, ownerId);
    enableFeature();
    const warn = vi.spyOn(logger, "warn").mockImplementation((() => undefined) as never);
    await db.update(agents).set({ metadata: sql`jsonb_set(${agents.metadata}, ARRAY['defaultMcp','entries']::text[], '[]'::jsonb)` }).where(eq(agents.id, bad.id));
    const report = await real(companyId);
    await waitForScheduledDefaultMcpSetups();
    expect(outcomeOf(report, bad.id)).toMatchObject({ result: "skipped", reason: "corrupted_existing_state" });
    expect(outcomeOf(report, good.id)).toMatchObject({ result: "added" });
    expect(JSON.stringify(report)).not.toMatch(/token|secret|bearer/i);
    warn.mockRestore();
  });

  it("batches with limit and afterId", async () => {
    const companyId = await seedCompany();
    const ownerId = await seedOwner(companyId);
    await arcanaOnlyAgent(companyId, ownerId);
    await arcanaOnlyAgent(companyId, ownerId);
    await arcanaOnlyAgent(companyId, ownerId);
    enableFeature();
    const first = await addMissingDefaultMcpEntries(db, { companyId, limit: 2 });
    expect(first.scanned).toBe(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await addMissingDefaultMcpEntries(db, { companyId, limit: 2, afterId: first.nextCursor! });
    expect(second.scanned).toBe(1);
    expect(second.nextCursor).toBeNull();
  });
});
