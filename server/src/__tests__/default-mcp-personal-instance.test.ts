import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TOOL_QUARANTINE_REASON_REVIEWED_DECLINED } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  connectionGrants,
  connectionTokenIssuances,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  runIdentityContexts,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolActionRequests,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolGatewaySessions,
  toolInvocations,
  toolOauthStates,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { toolAccessService } from "../services/tool-access.js";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { loadPersonalOwnerCaps, managedInstallCheck } from "../services/default-mcp-install-gate.js";
import {
  DEFAULT_MCP_SPEC_ENABLED_ENV,
  DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY,
  DEFAULT_MCP_MANAGED_CONFIG_KEY,
  readDefaultMcpState,
  type DefaultMcpAgentState,
} from "../services/default-mcp-spec.js";
import {
  ensureCompanyDefaultMcpOAuthSeeds,
  waitForScheduledCompanyOAuthSeeds,
} from "../services/default-mcp-oauth-seed.js";
import {
  DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  __resetDefaultMcpTemplateScopeForTests,
  captureDefaultMcpTemplateScope,
} from "../secrets/default-mcp-template-scope.js";
import {
  __resetCompanyTemplateDeferralsForTests,
  waitForScheduledCompanyTemplates,
} from "../services/default-mcp-template.js";
import { waitForScheduledDefaultMcpSetups } from "../services/default-mcp-setup.js";
import { mcpRemoteResponse } from "./helpers/mcp-remote-response.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * TECH-7340 — strict personal default-MCP instances (the rows a human's "Connect
 * your account" creates from a discovery-only seed) and the safety gates around
 * them. All network-free: seeds never call out, and every OAuth/network surface
 * (start/callback/catalog) is covered by the generic-mcp suite with its fixture.
 */
const GOOGLE_URL_ENV = "PAPERCLIP_DEFAULT_MCP_RH_GOOGLE_MCP_URL";
const GOOGLE_URL = "https://8.8.8.8/mcp"; // network-independent approved-inert IP literal; never fetched here

describeEmbeddedPostgres("personal default-MCP instances (TECH-7340)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-default-mcp-personal-${randomUUID()}`);
  const envKeys = [
    DEFAULT_MCP_SPEC_ENABLED_ENV,
    GOOGLE_URL_ENV,
    "PAPERCLIP_DEFAULT_MCP_RH_MCP_URL",
    DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV,
  ];

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("default-mcp-personal-instance");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  beforeEach(() => {
    for (const key of envKeys) delete process.env[key];
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    vi.stubGlobal("fetch", vi.fn(() => {
      throw new Error("personal-instance service tests must not make network calls");
    }));
  });

  afterEach(async () => {
    await waitForScheduledDefaultMcpSetups();
    await waitForScheduledCompanyTemplates();
    await waitForScheduledCompanyOAuthSeeds();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const key of envKeys) delete process.env[key];
    __resetCompanyTemplateDeferralsForTests();
    __resetDefaultMcpTemplateScopeForTests();
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(connectionTokenIssuances);
    await db.delete(secretAccessEvents);
    await db.delete(toolCallEvents);
    await db.delete(toolActionRequests);
    await db.delete(toolInvocations);
    await db.delete(toolGatewaySessions);
    await db.delete(runIdentityContexts);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(toolPolicies);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolOauthStates);
    await db.delete(connectionGrants);
    await db.delete(toolConnectionInstalls);
    await db.delete(companySecretBindings);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  // ---- harness ------------------------------------------------------------------------------

  function enableSeeds() {
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";
    process.env[GOOGLE_URL_ENV] = GOOGLE_URL;
    process.env["PAPERCLIP_DEFAULT_MCP_RH_MCP_URL"] = "https://8.8.8.8/mcp";
    captureDefaultMcpTemplateScope({}); // unset -> every company
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: "active",
    });
    return companyId;
  }

  async function seedMember(companyId: string, opts: { role?: string | null; status?: string; principalType?: "user" | "agent"; noUserRow?: boolean } = {}) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    if (!opts.noUserRow) {
      await db.insert(authUsers).values({
        id: userId,
        name: "Member",
        email: `${userId}@redesignhealth.com`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.insert(companyMemberships).values({
      companyId,
      principalType: opts.principalType ?? "user",
      principalId: userId,
      status: opts.status ?? "active",
      membershipRole: opts.role === undefined ? "member" : opts.role,
      createdAt: now,
    });
    return userId;
  }

  async function seedAgent(companyId: string, opts: { state?: DefaultMcpAgentState | null } = {}) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name: `Agent ${randomUUID().slice(0, 6)}`,
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        ...(opts.state ? { metadata: { defaultMcp: opts.state } } : {}),
      })
      .returning();
    return agent!;
  }

  function agentState(opts: { connectionId?: string | null } = {}): DefaultMcpAgentState {
    return {
      version: 1,
      entries: {
        "rh-google-mcp": {
          key: "rh-google-mcp",
          templateKey: "rh-google-mcp",
          dedicated: false,
          enabled: false,
          templateConnectionId: opts.connectionId ?? null,
          connectionId: opts.connectionId ?? null,
          ownerUserId: null,
          setup: {
            state: "not_required",
            reason: null,
            attemptCount: 0,
            nextAttemptAt: null,
            leaseUntil: null,
            claimId: null,
            registerAttemptedAt: null,
            mintAttemptedAt: null,
            updatedAt: new Date().toISOString(),
          },
          binding: null,
        },
      },
    };
  }

  const svc = () => toolAccessService(db);
  const userActor = (userId: string) => ({ actorType: "user" as const, actorId: userId });
  const agentActor = (agentId: string) => ({ actorType: "agent" as const, actorId: agentId });

  async function googleSeed(companyId: string) {
    const [row] = await db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, "rh-google-mcp/default-mcp-seed")));
    return row ?? null;
  }

  async function instanceRow(companyId: string, userId: string) {
    const [row] = await db
      .select()
      .from(toolConnections)
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.uid, `rh-google-mcp/default-mcp-personal/${userId}`),
        ),
      );
    return row ?? null;
  }

  async function seededCompanyWithMembers(opts: { roles?: { a?: string | null; b?: string | null } } = {}) {
    enableSeeds();
    const companyId = await seedCompany();
    const userA = await seedMember(companyId, { role: opts.roles?.a ?? "member" });
    const userB = await seedMember(companyId, { role: opts.roles?.b ?? "member" });
    await ensureCompanyDefaultMcpOAuthSeeds({ db }, { companyId });
    return { companyId, userA, userB };
  }

  const toolRowsOf = async (companyId: string) => {
    const [connections, applications, profiles, bindings, installs, grants, catalog, oauthStates] = await Promise.all([
      db.select().from(toolConnections).where(eq(toolConnections.companyId, companyId)),
      db.select().from(toolApplications).where(eq(toolApplications.companyId, companyId)),
      db.select().from(toolProfiles).where(eq(toolProfiles.companyId, companyId)),
      db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, companyId)),
      db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.companyId, companyId)),
      db.select().from(connectionGrants).where(eq(connectionGrants.companyId, companyId)),
      db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.companyId, companyId)),
      db.select().from(toolOauthStates).where(eq(toolOauthStates.companyId, companyId)),
    ]);
    return { connections, applications, profiles, bindings, installs, grants, catalog, oauthStates };
  };

  // ---- ensurePersonalDefaultMcpInstance ------------------------------------------------------

  it("two active humans in one company each get a stable, distinct personal instance; connecting twice is idempotent", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;

    const a1 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const b1 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    const a2 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    expect(a1.uid).toBe(`rh-google-mcp/default-mcp-personal/${userA}`);
    expect(b1.uid).toBe(`rh-google-mcp/default-mcp-personal/${userB}`);
    expect(a1.uid).not.toBe(b1.uid);
    expect(a2.id).toBe(a1.id); // repeat connect: same row, not a second one
    // Concurrent connects converge on one row per person.
    const [a3, a4] = await Promise.all([
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
    ]);
    expect(a3.id).toBe(a1.id);
    expect(a4.id).toBe(a1.id);

    const rows = await toolRowsOf(companyId);
    expect(rows.connections.filter((row) => (row.config as Record<string, unknown>)[DEFAULT_MCP_MANAGED_CONFIG_KEY] === "personal")).toHaveLength(2);
    expect(rows.grants).toHaveLength(0); // an instance row is consent plumbing only: no grant yet
    expect(rows.installs).toHaveLength(0);
    expect(rows.profiles).toHaveLength(0);
    expect(rows.bindings).toHaveLength(0);
    expect(rows.catalog).toHaveLength(0);
  });

  it("the instance copies the seed's endpoint and tags, is draft/disabled, per-user, personal_only, and owned by its creator", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    const instance = await svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    expect(instance).toMatchObject({
      companyId,
      applicationId: seed.applicationId,
      uid: `rh-google-mcp/default-mcp-personal/${userA}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "draft",
      enabled: false,
      createdByUserId: userA,
      createdByAgentId: null,
      credentialRefs: [],
      credentialSecretRefs: [],
    });
    const config = instance.config as Record<string, unknown>;
    expect(config).toMatchObject({
      url: GOOGLE_URL,
      mcpSessionRequired: true,
      quarantineNewEntries: true,
      [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal",
      [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-google-mcp",
      identityModel: "personal_only",
    });
    expect(config.defaultMcpTemplate).toBeUndefined();
    const transportConfig = instance.transportConfig as Record<string, unknown>;
    expect(transportConfig).toMatchObject({
      url: GOOGLE_URL,
      [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal",
      [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-google-mcp",
      identityModel: "personal_only",
    });
  });

  it("membership is the gate: non-members, invited, suspended, and agent principals get 403 and no row (viewers are refused by the route)", async () => {
    const { companyId } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const outsider = await seedMember(await seedCompany()); // active member of a DIFFERENT company
    const invited = await seedMember(companyId, { status: "invited" });
    const suspended = await seedMember(companyId, { status: "suspended" });
    const agentPrincipal = await seedMember(companyId, { principalType: "agent", noUserRow: true });

    for (const userId of [outsider, invited, suspended, agentPrincipal]) {
      await expect(
        service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userId),
      ).rejects.toMatchObject({ status: 403, details: { code: "active_membership_required" } });
    }
    const rows = await toolRowsOf(companyId);
    expect(rows.connections.filter((row) => row.createdByUserId !== null)).toHaveLength(0);
  });

  it("cross-company seeds fail closed: a foreign member gets 403 (by seed company) or 400 (by own company) and no row anywhere", async () => {
    const { companyId, userB } = await seededCompanyWithMembers();
    const otherCompanyId = await seedCompany();
    const foreigner = await seedMember(otherCompanyId);
    const seed = (await googleSeed(companyId))!;
    const service = svc();

    // Service called with the SEED's company: the foreign member fails the locked membership check.
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, foreigner),
    ).rejects.toMatchObject({ status: 403, details: { code: "active_membership_required" } });
    // Service called with the caller's own company: the foreign seed is simply not there.
    await expect(
      service.ensurePersonalDefaultMcpInstance(otherCompanyId, seed.id, foreigner),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_unavailable" } });

    for (const companyIdToCheck of [companyId, otherCompanyId]) {
      const rows = await toolRowsOf(companyIdToCheck);
      expect(rows.connections.filter((row) => row.createdByUserId === foreigner)).toHaveLength(0);
    }
    void userB;
  });

  it("a forged personal-instance row with the wrong owner is a 409 conflict, not a takeover", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    // A row squatting on B's expected UID but owned by A.
    await db.insert(toolConnections).values({
      companyId,
      applicationId: seed.applicationId,
      name: "Squatter",
      uid: `rh-google-mcp/default-mcp-personal/${userB}`,
      connectionKind: "managed",
      ownership: "customer",
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "draft",
      enabled: false,
      config: { url: GOOGLE_URL, [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal", [DEFAULT_MCP_ENTRY_TAG_CONFIG_KEY]: "rh-google-mcp", identityModel: "personal_only" },
      transportConfig: {},
      credentialRefs: [],
      credentialSecretRefs: [],
      createdByUserId: userA,
    });

    await expect(
      svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userB),
    ).rejects.toMatchObject({ status: 409, details: { code: "personal_instance_conflict" } });
    // A still gets their own instance at their own UID.
    const aInstance = await svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    expect(aInstance.uid).toBe(`rh-google-mcp/default-mcp-personal/${userA}`);
  });

  it("an archived seed is unavailable; an archived own instance revives to draft with every grant, credential, and review preserved", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    // Owner-reviewed catalog + a user grant + an explicit install survive archival and revival byte-identically.
    const [catalogEntry] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: instance.applicationId, connectionId: instance.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "active", reviewedAt: new Date(), versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning();
    const [grant] = await db
      .insert(connectionGrants)
      .values({ companyId, connectionId: instance.id, kind: "user", subjectUserId: userA, status: "active", isDefault: false, credentialSecretRefs: [], createdByUserId: userA })
      .returning();
    const agent = await seedAgent(companyId);
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: instance.id, targetType: "agent", targetId: agent.id });

    await db.update(toolConnections).set({ status: "archived", updatedAt: new Date() }).where(eq(toolConnections.id, instance.id));
    const revived = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    expect(revived.id).toBe(instance.id);
    expect(revived.status).toBe("draft");
    expect(revived.config).toEqual(instance.config);
    expect(revived.credentialSecretRefs).toEqual(instance.credentialSecretRefs);
    const grantsAfter = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, instance.id));
    expect(grantsAfter).toEqual([grant]);
    const installsAfter = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, instance.id));
    expect(installsAfter).toHaveLength(1);
    const catalogAfter = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.connectionId, instance.id));
    expect(catalogAfter).toEqual([catalogEntry]);
    // No re-mint, no wipe: no oauth state was created by revival.
    expect((await toolRowsOf(companyId)).oauthStates).toHaveLength(0);

    // An archived seed, in contrast, is gone for good.
    await db.update(toolConnections).set({ status: "archived", updatedAt: new Date() }).where(eq(toolConnections.id, seed.id));
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_unavailable" } });
  });

  it("ensurePersonalDefaultMcpInstance enforces pre-checks, non-UUID uid safety, and configured endpoint validation (S3, S7)", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;

    // Non-UUID seedIdOrUid string safely matches uid without Postgres 22P02 syntax error
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, "non-existent-seed-slug", userA),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_unavailable" } });

    // Calling with valid uid also works
    const instanceByUid = await service.ensurePersonalDefaultMcpInstance(companyId, seed.uid!, userA);
    expect(instanceByUid.uid).toBe(`rh-google-mcp/default-mcp-personal/${userA}`);

    // Disabled spec
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "false";
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_unavailable" } });
    process.env[DEFAULT_MCP_SPEC_ENABLED_ENV] = "true";

    // Company outside template scope
    const otherCompanyId = await seedCompany();
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({ [DEFAULT_MCP_TEMPLATE_COMPANY_IDS_ENV]: otherCompanyId });
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_unavailable" } });
    __resetDefaultMcpTemplateScopeForTests();
    captureDefaultMcpTemplateScope({}); // reset to all companies

    // Changed / unconfigured seed endpoint
    delete process.env[GOOGLE_URL_ENV];
    await expect(
      service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_unavailable" } });
    process.env[GOOGLE_URL_ENV] = GOOGLE_URL;
  });

  it("reviving an archived instance preserves user-reviewed profile choices and mock callback activates without wiping choices (B2 regression)", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    // Create custom profile and catalog entries with denied status
    const [profile] = await db
      .insert(toolProfiles)
      .values({
        companyId,
        profileKey: `app:${instance.id}`,
        name: instance.name,
        defaultAction: "allow",
      })
      .returning();
    const [deniedEntry] = await db
      .insert(toolCatalogEntries)
      .values({
        companyId,
        applicationId: instance.applicationId,
        connectionId: instance.id,
        entryKind: "tool",
        name: "dangerous_tool",
        toolName: "dangerous_tool",
        title: "Dangerous Tool",
        riskLevel: "destructive",
        isReadOnly: false,
        status: "quarantined",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: profile!.id,
      selectorType: "catalog_entry",
      catalogEntryId: deniedEntry!.id,
      effect: "deny",
    });

    // Archive the personal instance
    await db
      .update(toolConnections)
      .set({ status: "archived", updatedAt: new Date() })
      .where(eq(toolConnections.id, instance.id));

    // Revival revives connection to draft while preserving existing profile & entries
    const revived = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    expect(revived.id).toBe(instance.id);
    expect(revived.status).toBe("draft");

    const [existingProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${instance.id}`)));
    expect(existingProfile).toBeDefined();

    const profileEntriesBefore = await db
      .select()
      .from(toolProfileEntries)
      .where(eq(toolProfileEntries.profileId, existingProfile!.id));
    expect(profileEntriesBefore).toHaveLength(1);
    expect(profileEntriesBefore[0]?.effect).toBe("deny");
  });

  // ---- OAuth start gates ---------------------------------------------------------------------

  it("starting OAuth directly on a seed is a 409 with no OAuth state; A cannot start OAuth on B's instance", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);

    await expect(
      service.startOAuth(companyId, seed.id, { redirectUri: "https://paperclip.example.test/api/tools/oauth/callback", actor: userActor(userA) }),
    ).rejects.toMatchObject({ status: 409, details: { code: "default_mcp_seed_not_connectable" } });

    // A starting sign-in on B's instance: the fixed personal identity is B, so A is refused 403.
    await expect(
      service.startOAuth(companyId, bInstance.id, {
        redirectUri: "https://paperclip.example.test/api/tools/oauth/callback",
        actor: userActor(userA),
        subjectUserId: userA,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await toolRowsOf(companyId)).oauthStates).toHaveLength(0);
  });

  // ---- shared company identity is refused ----------------------------------------------------

  it("a shared organization identity (addConnectionInstallation) is refused on personal instances and seeds", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

    await expect(
      service.addConnectionInstallation(instance.id, { credentialSecretRefs: [] }, userActor(userA)),
    ).rejects.toMatchObject({ status: 422, details: { code: "personal_default_mcp_requires_personal_grant" } });
    await expect(
      service.addConnectionInstallation(seed.id, { credentialSecretRefs: [] }, userActor(userA)),
    ).rejects.toMatchObject({ status: 409, details: { code: "managed_template_not_installable" } });
    const rows = await toolRowsOf(companyId);
    expect(rows.grants).toHaveLength(0);
  });

  // ---- install producer gates ----------------------------------------------------------------

  it("seeds are never installable; personal instances are agent-only, owner-only, and one-owner-per-agent", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const aInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    const agent = await seedAgent(companyId, { state: agentState() });

    // A seed is not installable for anyone, company- or agent-targeted, even by the "owner".
    for (const installs of [
      [{ targetType: "company" as const, targetId: companyId }],
      [{ targetType: "agent" as const, targetId: agent.id }],
    ]) {
      await expect(
        service.putConnectionInstalls(seed.id, { installs }, userActor(userA)),
      ).rejects.toMatchObject({ status: 409, details: { code: "managed_template_not_installable" } });
    }

    // A personal instance cannot be installed company-wide, even by its owner.
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "company", targetId: companyId }] }, userActor(userA)),
    ).rejects.toMatchObject({ status: 422, details: { code: "company_install_not_permitted" } });

    // Only the personal connection owner may add installs: another human (even an
    // owner-role admin) and any agent actor are refused 403.
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userB)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, agentActor(agent.id)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    expect((await toolRowsOf(companyId)).installs).toHaveLength(0);

    // The owner may install on their own agents.
    await service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    expect((await toolRowsOf(companyId)).installs).toHaveLength(1);

    // A second owner's same-entry instance on the same agent is a 409 conflict, both directions.
    await expect(
      service.putConnectionInstalls(bInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userB)),
    ).rejects.toMatchObject({ status: 409, details: { code: "personal_instance_conflict" } });

    // M4: A and B CONCURRENTLY add their same-entry instances to the SAME fresh
    // agent. The sorted shared per-agent/entry advisory locks serialize them:
    // exactly one install lands and the loser gets the 409 conflict — never two
    // rows, never a deadlock.
    const secondAgent = await seedAgent(companyId, { state: agentState() });
    const [aAttempt, bAttempt] = await Promise.allSettled([
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: secondAgent.id }] }, userActor(userA)),
      service.putConnectionInstalls(bInstance.id, { installs: [{ targetType: "agent", targetId: secondAgent.id }] }, userActor(userB)),
    ]);
    const winners = [aAttempt, bAttempt].filter((attempt) => attempt.status === "fulfilled");
    const losers = [aAttempt, bAttempt].filter((attempt) => attempt.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 409,
      details: { code: "personal_instance_conflict" },
    });
    const concurrentInstalls = await db
      .select()
      .from(toolConnectionInstalls)
      .where(and(eq(toolConnectionInstalls.companyId, companyId), eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, secondAgent.id)));
    expect(concurrentInstalls).toHaveLength(1);
    expect([aInstance.id, bInstance.id]).toContain(concurrentInstalls[0]!.connectionId);

    // Authorized removal (owners clear their installs) is allowed.
    await service.putConnectionInstalls(aInstance.id, { installs: [] }, userActor(userA));
    await service.putConnectionInstalls(bInstance.id, { installs: [] }, userActor(userB));
    expect((await toolRowsOf(companyId)).installs).toHaveLength(0);
    // And a non-owner clearing is a removal, not an addition: no owner gate applies.
    await service.putConnectionInstalls(aInstance.id, { installs: [] }, userActor(userB));
    expect((await toolRowsOf(companyId)).installs).toHaveLength(0);
  });

  it("COUNTEREXAMPLE (guard-all-producer-paths): a non-owner manager cannot finish/review someone else's personal instance", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers({ roles: { a: "member", b: "member" } });
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    // B's owner review is pending: one quarantined catalog entry from the consented catalog.
    const [quarantined] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: bInstance.applicationId, connectionId: bInstance.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "quarantined", versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning();

    // The finish route's gate (creator OR connection manager) lets a manager through; the
    // service must still refuse a non-owner finish: enabling B's quarantined tool and binding
    // the whole company is exactly the install/owner bypass the PUT path already refuses.
    const managerActor = userActor(userA);
    await expect(
      service.finishGalleryAppConnection(companyId, bInstance.id, {
        enabledCatalogEntryIds: [],
        askFirstCatalogEntryIds: [],
        reviewedCatalogEntryIds: [quarantined!.id],
        access: "all_agents",
      }, managerActor),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "personal_instance_owner_required" },
    });
    // No actor-owner fallback: an agent actor, and an omitted actor, are never the
    // personal owner either — only the validated personal subject may finish.
    const agent = await seedAgent(companyId, { state: agentState() });
    for (const finishActor of [agentActor(agent.id), undefined]) {
      await expect(
        service.finishGalleryAppConnection(companyId, bInstance.id, {
          enabledCatalogEntryIds: [],
          askFirstCatalogEntryIds: [],
          reviewedCatalogEntryIds: [quarantined!.id],
          access: "all_agents",
        }, finishActor),
      ).rejects.toMatchObject({
        status: 403,
        details: { code: "personal_instance_owner_required" },
      });
    }
    // The owner's own finish is the review path (covered end-to-end in the generic suite).
    // Regardless of the guard's shape, nothing may have been enabled or bound.
    const rows = await toolRowsOf(companyId);
    expect(rows.bindings).toHaveLength(0);
    expect(rows.profiles).toHaveLength(0);
    expect(rows.catalog.map((entry) => entry.status)).toEqual(["quarantined"]);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, bInstance.id)))[0]!.status).toBe("draft");
  });

  it("an instance admin can review a personal instance's tools, install it on agents and re-enable it, but never bind the whole company", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers({ roles: { a: "member", b: "member" } });
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const aInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const { writeConnectionCredential } = await import("../services/connection-credentials.js");
    const { secret } = await writeConnectionCredential(db, {
      companyId,
      connectionName: aInstance.name,
      configPath: "oauth.access_token",
      label: "a token",
      value: "token-a",
      ownerUserId: userA,
      definitionKey: `test.a.${randomUUID()}`,
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: aInstance.id,
      kind: "user",
      subjectUserId: userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
      createdByUserId: userA,
    });
    const agent = await seedAgent(companyId, { state: agentState() });
    const [readEntry, sendEntry] = await db
      .insert(toolCatalogEntries)
      .values(["gmail_search", "gmail_send"].map((name) => ({
        companyId, applicationId: aInstance.applicationId, connectionId: aInstance.id, entryKind: "tool" as const,
        name, toolName: name, title: name, riskLevel: "read", isReadOnly: true, status: "quarantined" as const,
        quarantineReason: "pending_review", versionHash: randomUUID(), schemaHash: randomUUID(),
      })))
      .returning();
    // The owner installs one agent first, as the real first consent does.
    await service.finishGalleryAppConnection(companyId, aInstance.id, {
      enabledCatalogEntryIds: [],
      askFirstCatalogEntryIds: [],
      access: { agentIds: [agent.id] },
    }, userActor(userA));
    const installsBefore = (await toolRowsOf(companyId)).installs.map((install) => install.targetId);
    expect(installsBefore).toEqual([agent.id]);

    const adminActor = { ...userActor(userB), isInstanceAdmin: true };
    const review = {
      enabledCatalogEntryIds: [readEntry!.id],
      askFirstCatalogEntryIds: [],
      reviewedCatalogEntryIds: [readEntry!.id, sendEntry!.id],
    };

    // A non-admin manager is still refused, and so is an admin who tries to bind the whole company.
    await expect(
      service.finishGalleryAppConnection(companyId, aInstance.id, { ...review, preserveExistingAccess: true, access: { agentIds: [] } }, userActor(userB)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    await expect(
      service.finishGalleryAppConnection(companyId, aInstance.id, { ...review, preserveExistingAccess: true, access: "all_agents" }, adminActor),
    ).rejects.toMatchObject({ status: 422, details: { code: "company_install_not_permitted" } });
    expect((await toolRowsOf(companyId)).catalog.map((entry) => entry.status).sort()).toEqual(["quarantined", "quarantined"]);

    // The admin's review enables one tool, declines the other, and leaves the owner's install untouched.
    await service.finishGalleryAppConnection(companyId, aInstance.id, { ...review, preserveExistingAccess: true, access: { agentIds: [] } }, adminActor);
    const rows = await toolRowsOf(companyId);
    expect(rows.installs.map((install) => install.targetId)).toEqual(installsBefore);
    const byName = Object.fromEntries(rows.catalog.map((entry) => [entry.toolName, entry]));
    expect(byName.gmail_search!.status).toBe("active");
    expect(byName.gmail_send!.status).toBe("quarantined");
    expect(byName.gmail_send!.quarantineReason).toBe(TOOL_QUARANTINE_REASON_REVIEWED_DECLINED);
    const effective = await service.getEffectiveProfilesForAgent(companyId, agent.id);
    expect(effective.allowedToolNames).toContain("gmail_search");
    expect(effective.allowedToolNames).not.toContain("gmail_send");

    // The admin can edit the personal instance's access profile; a non-admin manager cannot.
    const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${aInstance.id}`)));
    await service.updateProfile(profile!.id, { description: "reviewed by an instance admin" } as never, adminActor);
    await expect(
      service.updateProfile(profile!.id, { description: "tampered" } as never, userActor(userB)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });

    // But nobody, admin or owner, can bind the profile to the whole company, directly or by reassigning a
    // company-wide binding onto it when another profile is deleted.
    for (const actor of [adminActor, userActor(userA)]) {
      await expect(
        service.bindProfile(profile!.id, { targetType: "company", targetId: companyId, priority: 100 } as never, actor),
      ).rejects.toMatchObject({ status: 422, details: { code: "company_install_not_permitted" } });
    }
    const [companyWide] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `company-wide-${randomUUID()}`, name: `Company wide ${randomUUID()}`, status: "active", defaultAction: "deny" })
      .returning();
    await db.insert(toolProfileBindings).values({ companyId, profileId: companyWide!.id, targetType: "company", targetId: companyId, priority: 100 });
    await expect(
      service.deleteProfile(companyWide!.id, { reassignToProfileId: profile!.id } as never, adminActor),
    ).rejects.toMatchObject({ status: 422, details: { code: "company_install_not_permitted" } });
    expect((await toolRowsOf(companyId)).bindings.filter((binding) => binding.targetType === "company")).toHaveLength(1);

    // putConnectionInstalls directly: a non-admin manager is refused, the admin is allowed.
    const otherAgent = await seedAgent(companyId, { state: agentState() });
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: otherAgent.id }] }, userActor(userB)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    // The one-owner-per-agent rule still binds an admin: an agent held by B's own instance cannot be taken.
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    const contested = await seedAgent(companyId, { state: agentState() });
    await service.putConnectionInstalls(bInstance.id, { installs: [{ targetType: "agent", targetId: contested.id }] }, userActor(userB));
    await expect(
      service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: contested.id }] }, adminActor),
    ).rejects.toMatchObject({ status: 409, details: { code: "personal_instance_conflict" } });

    // The admin can also move the install to another agent, as the owner can.
    await service.finishGalleryAppConnection(companyId, aInstance.id, { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [otherAgent.id] } }, adminActor);
    expect((await toolRowsOf(companyId)).installs.filter((install) => install.connectionId === aInstance.id).map((install) => install.targetId)).toEqual([otherAgent.id]);
    // Re-enabling needs the owner or an admin.
    await service.updateConnection(aInstance.id, { enabled: false }, companyId, userActor(userA));
    await expect(
      service.updateConnection(aInstance.id, { enabled: true }, companyId, userActor(userB)),
    ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
    await service.updateConnection(aInstance.id, { enabled: true }, companyId, adminActor);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, aInstance.id)))[0]!.enabled).toBe(true);
  });

  it("finishing a personal instance never saves an access choice that reaches no agent: all-agents is refused loudly, chosen agents are installed and see the tools", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers({ roles: { a: "member", b: "member" } });
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const aInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const bInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
    const { writeConnectionCredential } = await import("../services/connection-credentials.js");
    const { secret: aSecret } = await writeConnectionCredential(db, {
      companyId,
      connectionName: aInstance.name,
      configPath: "oauth.access_token",
      label: "a token",
      value: "token-a",
      ownerUserId: userA,
      definitionKey: `test.a.${randomUUID()}`,
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: aInstance.id,
      kind: "user",
      subjectUserId: userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: aSecret.id, configPath: "oauth.access_token" }],
      createdByUserId: userA,
    });
    const { secret: bSecret } = await writeConnectionCredential(db, {
      companyId,
      connectionName: bInstance.name,
      configPath: "oauth.access_token",
      label: "b token",
      value: "token-b",
      ownerUserId: userB,
      definitionKey: `test.b.${randomUUID()}`,
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: bInstance.id,
      kind: "user",
      subjectUserId: userB,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: bSecret.id, configPath: "oauth.access_token" }],
      createdByUserId: userB,
    });
    const agent = await seedAgent(companyId, { state: agentState() });
    const otherAgent = await seedAgent(companyId, { state: agentState() });
    const [entry] = await db
      .insert(toolCatalogEntries)
      .values({ companyId, applicationId: aInstance.applicationId, connectionId: aInstance.id, entryKind: "tool", name: "calendar_list_events", toolName: "calendar_list_events", title: "List events", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID() })
      .returning();
    const finishInput = (access: "all_agents" | { agentIds: string[] }) => ({
      enabledCatalogEntryIds: [entry!.id],
      askFirstCatalogEntryIds: [],
      access,
    });

    // "All agents" is refused with a clear code, and nothing is written (no profile, binding or install).
    await expect(
      service.finishGalleryAppConnection(companyId, aInstance.id, finishInput("all_agents"), userActor(userA)),
    ).rejects.toMatchObject({ status: 422, details: { code: "company_install_not_permitted" } });
    let rows = await toolRowsOf(companyId);
    expect(rows.installs).toHaveLength(0);
    expect(rows.bindings).toHaveLength(0);

    // Choosing an agent installs it (install row + binding), and the agent now sees the connection and its tool.
    await service.finishGalleryAppConnection(companyId, aInstance.id, finishInput({ agentIds: [agent.id] }), userActor(userA));
    rows = await toolRowsOf(companyId);
    expect(rows.installs.map((install) => `${install.targetType}:${install.targetId}:${install.connectionId}`)).toEqual([`agent:${agent.id}:${aInstance.id}`]);
    expect(rows.bindings.map((binding) => `${binding.targetType}:${binding.targetId}`)).toEqual([`agent:${agent.id}`]);
    const effective = await service.getEffectiveProfilesForAgent(companyId, agent.id);
    expect(effective.installedConnections.map((connection) => connection.id)).toContain(aInstance.id);
    expect(effective.allowedToolNames).toContain("calendar_list_events");
    // An agent that was not chosen sees neither.
    const notChosen = await service.getEffectiveProfilesForAgent(companyId, otherAgent.id);
    expect(notChosen.installedConnections.map((connection) => connection.id)).not.toContain(aInstance.id);

    // Re-finishing with a different choice moves the install; it does not leave a stale one behind.
    await service.finishGalleryAppConnection(companyId, aInstance.id, finishInput({ agentIds: [otherAgent.id] }), userActor(userA));
    rows = await toolRowsOf(companyId);
    expect(rows.installs.map((install) => install.targetId)).toEqual([otherAgent.id]);

    // The one-owner-per-agent rule still holds on this path: B cannot take an agent A's same-entry instance holds.
    await expect(
      service.finishGalleryAppConnection(companyId, bInstance.id, finishInput({ agentIds: [otherAgent.id] }), userActor(userB)),
    ).rejects.toMatchObject({ status: 409, details: { code: "personal_instance_conflict" } });
    expect((await toolRowsOf(companyId)).installs.map((install) => install.connectionId)).toEqual([aInstance.id]);
  });

  // ---- updateConnection (seed immutable; personal instance pinned) --------------------------

  it("a seed is server-owned: every public mutation except archiving is a 409, and archiving preserves it byte for byte", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;

    const mutations: Array<Record<string, unknown>> = [
      { name: "Renamed" },
      { enabled: true },
      { status: "active" },
      { transport: "stdio_command" },
      { authKind: "api_key" },
      { credentialPolicy: "shared" },
      { config: { url: "https://evil.example.test/mcp" } },
      { transportConfig: { url: "https://evil.example.test/mcp" } },
      { credentialSecretRefs: [{ secretId: randomUUID(), configPath: "oauth.access_token" }] },
      { credentialRefs: [{ name: "credentials.authorization", secretId: randomUUID(), version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }] },
      { name: "x", config: { [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "personal" } },
    ];
    for (const input of mutations) {
      await expect(service.updateConnection(seed.id, input as never)).rejects.toMatchObject({
        status: 409,
        details: { code: "managed_seed_immutable" },
      });
    }

    // The one allowed change: archiving (org opt-out). The row stays byte-identical otherwise.
    const before = (await googleSeed(companyId))!;
    await service.updateConnection(seed.id, { status: "archived" });
    const after = (await googleSeed(companyId))!;
    expect(after.status).toBe("archived");
    expect({ ...after, status: before.status, updatedAt: after.updatedAt }).toEqual({
      ...before,
      status: before.status,
      updatedAt: after.updatedAt,
    });
    void userA;
  });

  it("a personal instance is immutable except the enabled toggle and archiving: every identity/exfiltration mutation is a 409", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    // A real same-company secret so the secret-ref attempts pass shape validation and the
    // PERSONAL-INSTANCE guard (not a 422) is what the test observes.
    const secretService = (await import("../services/secrets.js")).secretService;
    const secret = await secretService(db).create(companyId, {
      name: "exfiltration attempt secret",
      key: `google.${randomUUID()}`,
      provider: "local_encrypted",
      value: "would-be-exfiltrated-token",
    });

    const refused: Array<Record<string, unknown>> = [
      { name: "My Google" },
      { transport: "local_stdio" },
      { authKind: "api_key" },
      { credentialPolicy: "shared" },
      { status: "active" },
      { config: { url: "https://evil.example.test/mcp", [DEFAULT_MCP_MANAGED_CONFIG_KEY]: "dedicated" } },
      { transportConfig: { url: "https://evil.example.test/mcp" } },
      // H1: public attempts to re-route OAuth credentials/token endpoints are refused too.
      { config: { oauth: { tokenUrl: "https://evil.example.test/token", authorizationUrl: "https://evil.example.test/authorize" } } },
      { config: { oauth: { clientSecretEnv: "STOLEN_SECRET_ENV" } } },
      { transportConfig: { oauth: { tokenUrl: "https://evil.example.test/token" } } },
      { credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.exfiltrate" }] },
      { credentialRefs: [{ name: "credentials.authorization", secretId: secret.id, version: "latest", placement: "header", key: "Authorization", prefix: "Bearer " }] },
      { enabled: true, name: "sneaky combo" },
    ];
    for (const input of refused) {
      await expect(service.updateConnection(instance.id, input as never)).rejects.toMatchObject({
        status: 409,
        details: { code: "personal_instance_immutable" },
      });
    }

    // Disabling and archiving are allowed by managers, but re-enabling requires the owner.
    await service.updateConnection(instance.id, { enabled: false }, companyId, userActor(userB));
    await expect(
      service.updateConnection(instance.id, { enabled: true }, companyId, userActor(userB)),
    ).rejects.toMatchObject({
      status: 403,
      details: { code: "personal_instance_owner_required" },
    });

    // The enabled toggle is the one allowed live change for the owner, and it pins every server-owned fact.
    const updated = await service.updateConnection(instance.id, { enabled: true }, companyId, userActor(userA));
    expect(updated.enabled).toBe(true);
    expect(updated.name).toBe(instance.name);
    expect(updated.transport).toBe("mcp_remote");
    expect(updated.authKind).toBe("oauth");
    expect(updated.credentialPolicy).toBe("per_user");
    const config = updated.config as Record<string, unknown>;
    expect(config).toEqual(instance.config);
    expect(updated.credentialSecretRefs).toEqual(instance.credentialSecretRefs);
    expect(updated.credentialRefs).toEqual(instance.credentialRefs);
    const transportConfig = updated.transportConfig as Record<string, unknown>;
    expect(transportConfig).toEqual(instance.transportConfig);

    // Archiving (the owner's removal) is allowed and preserves everything else.
    const archived = await service.updateConnection(instance.id, { status: "archived" });
    expect(archived.status).toBe("archived");
    expect(archived.config).toEqual(instance.config);
    expect(archived.credentialSecretRefs).toEqual(instance.credentialSecretRefs);
  });

  // ---- install gate / effective profiles / token mint ----------------------------------------

  it("managedInstallCheck and effective profiles exclude seeds for legacy and snapshot-managed agents, whatever rows exist", async () => {
    const { companyId } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    const legacyAgent = await seedAgent(companyId); // no defaultMcp state
    const stateAgent = await seedAgent(companyId, { state: agentState() });

    // Forged rows: company install + company profile binding + active catalog on the seed.
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: seed.id, targetType: "company", targetId: companyId });
    const [profile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `app:${seed.id}`, name: "seed profile", defaultAction: "deny" })
      .returning();
    await db.insert(toolCatalogEntries).values({ companyId, applicationId: seed.applicationId, connectionId: seed.id, entryKind: "tool", name: "gmail_search", toolName: "gmail_search", title: "Gmail search", riskLevel: "read", isReadOnly: true, status: "active", versionHash: randomUUID(), schemaHash: randomUUID() });
    await db.insert(toolProfileEntries).values({ companyId, profileId: profile!.id, selectorType: "connection", effect: "include", connectionId: seed.id });
    await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "company", targetId: companyId });

    for (const agent of [legacyAgent, stateAgent]) {
      const identity = { id: seed.id, companyId, name: seed.name, config: seed.config };
      const check = await managedInstallCheck(db, { companyId, agentId: agent.id, connections: [identity] });
      expect(check.blocked.has(seed.id)).toBe(true);
      // The install projection excludes the seed even with the forged install row
      // (the company-bound profile keeping it "permitted" mirrors the managed-template
      // behavior: visible, but never installed and never callable).
      const effective = await svc().getEffectiveProfilesForAgent(companyId, agent.id);
      expect(effective.installedConnections.map((connection) => connection.id)).not.toContain(seed.id);
    }
  });

  it("minting a token for a seed is refused 403 installation_required before any secret is touched", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const seed = (await googleSeed(companyId))!;
    const agent = await seedAgent(companyId, { state: agentState() });
    // A forged install row that tries to make the seed look installed.
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: seed.id, targetType: "agent", targetId: agent.id });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userA })
      .returning();

    await expect(
      svc().mintConnectionTokenForAgent({ connectionId: seed.id, companyId, agentId: agent.id, runId: run!.id, body: {} }),
    ).rejects.toMatchObject({ details: { code: "installation_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0); // no secret was decrypted
    const issuances = await db.select().from(connectionTokenIssuances).where(eq(connectionTokenIssuances.connectionId, seed.id));
    expect(issuances.map((row) => [row.outcome, row.errorCode])).toContainEqual(["denied", "installation_required"]);
  });

  it("a run whose responsible user is not the installed instance's owner is refused 409 user_authorization_required before secret use", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const aInstance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const agent = await seedAgent(companyId, { state: agentState() });
    await service.putConnectionInstalls(aInstance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    // A's personal grant (the credential the mint would resolve for A).
    const secretService = (await import("../services/secrets.js")).secretService;
    const secret = await secretService(db).create(companyId, {
      name: "a google tokens",
      key: `google.${randomUUID()}`,
      provider: "local_encrypted",
      value: "a-access-token-value",
    });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: aInstance.id,
      kind: "user",
      subjectUserId: userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: secret!.id, configPath: "oauth.access_token" }],
      createdByUserId: userA,
    });

    // B is an active member and responsible for the run, but the only grant on this
    // instance belongs to A: B's runtime may not use A's personal Google account.
    const [bRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userB })
      .returning();
    await expect(
      service.mintConnectionTokenForAgent({ connectionId: aInstance.id, companyId, agentId: agent.id, runId: bRun!.id, body: {} }),
    ).rejects.toMatchObject({ status: 409, details: { code: "user_authorization_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
    const denied = await db.select().from(connectionTokenIssuances).where(eq(connectionTokenIssuances.connectionId, aInstance.id));
    expect(denied.map((row) => [row.outcome, row.errorCode])).toContainEqual(["denied", "user_authorization_required"]);

    // The owner's own responsible run passes the grant gate (it then stops at the
    // still-draft connection, which proves the gate is about the responsible user).
    const [aRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userA })
      .returning();
    await expect(
      service.mintConnectionTokenForAgent({ connectionId: aInstance.id, companyId, agentId: agent.id, runId: aRun!.id, body: {} }),
    ).rejects.not.toMatchObject({ details: { code: "user_authorization_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
  });

  // ---- S5: the owner's canonical app profile is an absolute runtime cap ----------------------

  const rhSeed = (companyId: string) =>
    db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.uid, "rh-mcp-personal/default-mcp-seed")))
      .then((rows) => rows[0] ?? null);

  /** A fully owner-capped Google instance: A owns it, X runs it, the canonical profile permits only the read tool. */
  async function cappedGoogleSetup() {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const agent = await seedAgent(companyId, { state: agentState() });
    await service.putConnectionInstalls(instance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, instance.id));

    const catalogEntry = async (toolName: string, riskLevel: "read" | "high") => {
      const [row] = await db
        .insert(toolCatalogEntries)
        .values({
          companyId,
          applicationId: instance.applicationId,
          connectionId: instance.id,
          entryKind: "tool",
          name: toolName,
          toolName,
          title: toolName,
          riskLevel,
          isReadOnly: riskLevel === "read",
          status: "active",
          versionHash: randomUUID(),
          schemaHash: randomUUID(),
        })
        .returning();
      return row!;
    };
    const readEntry = await catalogEntry("gmail_read", "read");
    const sendEntry = await catalogEntry("gmail_send", "high");

    // The owner's canonical app profile: the install producer already created it
    // (default deny, agent binding); the owner's review adds ONLY the read tool.
    const [ownerProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${instance.id}`)));
    expect(ownerProfile).toBeTruthy();
    // The canonical row must carry the wizard/owner-ceiling marker: loadPersonalOwnerCaps
    // recognizes an `app:<connId>` cap only by this exact metadata, so every capped test
    // below also guards that a personal instance is never stamped as an ordinary install.
    expect((ownerProfile!.metadata ?? {}) as Record<string, unknown>).toMatchObject({
      source: "app_gallery_finish",
      connectionId: instance.id,
    });
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: ownerProfile!.id,
      selectorType: "tool_name",
      toolName: "gmail_read",
      effect: "include",
    });

    return { companyId, userA, userB, agent, instance, seed, readEntry, sendEntry, ownerProfile: ownerProfile! };
  }

  type CappedSetup = Awaited<ReturnType<typeof cappedGoogleSetup>>;

  const decideFor = (
    companyId: string,
    agentId: string,
    request: {
      connectionId: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      catalogEntryId?: string;
      upstreamToolName?: string;
      /** Real invocations consume rate limits (and trust-rule hits); previews do not. */
      consumeRateLimit?: boolean;
    },
  ) => {
    const { consumeRateLimit, ...rest } = request;
    return toolAccessPolicyService(db).decide({
      companyId,
      actor: { actorType: "agent" as const, actorId: agentId, agentId },
      consumeRateLimit,
      request: { arguments: {}, ...rest },
    });
  };

  /** A generic profile by B (or a policy / permission grant) that tries to lift the cap. */
  async function buildBypass(kind: string, ctx: CappedSetup) {
    if (kind === "allow policy") {
      await db.insert(toolPolicies).values({
        companyId: ctx.companyId,
        name: "B allow policy",
        policyType: "allow",
        enabled: true,
        priority: 100,
        selectors: { toolName: "gmail_send" },
        description: "B allows the send tool",
      });
      return;
    }
    if (kind === "tools:use grant") {
      await db.insert(principalPermissionGrants).values({
        companyId: ctx.companyId,
        principalType: "agent",
        principalId: ctx.agent.id,
        permissionKey: "tools:use",
        scope: null,
      });
      return;
    }
    const [genericProfile] = await db
      .insert(toolProfiles)
      .values({
        companyId: ctx.companyId,
        profileKey: `generic-b-${randomUUID()}`,
        name: `Generic include by B (${kind})`,
        status: "active",
        defaultAction: "deny",
      })
      .returning();
    const entryValues: Record<string, unknown> = {
      companyId: ctx.companyId,
      profileId: genericProfile!.id,
      selectorType: kind,
      effect: "include",
    };
    if (kind === "application") entryValues.applicationId = ctx.instance.applicationId;
    if (kind === "connection") entryValues.connectionId = ctx.instance.id;
    if (kind === "catalog_entry") entryValues.catalogEntryId = ctx.sendEntry.id;
    if (kind === "tool_name") entryValues.toolName = "gmail_send";
    if (kind === "risk_level") entryValues.riskLevel = "high";
    await db.insert(toolProfileEntries).values(entryValues as never);
    await db.insert(toolProfileBindings).values({
      companyId: ctx.companyId,
      profileId: genericProfile!.id,
      targetType: "agent",
      targetId: ctx.agent.id,
    });
  }

  it.each([
    "application",
    "connection",
    "catalog_entry",
    "tool_name",
    "risk_level",
    "allow policy",
    "tools:use grant",
  ] as const)(
    "S5 BYPASS COUNTEREXAMPLE (%s): neither a generic selector, an allow policy, nor an explicit tools:use grant lifts the owner cap",
    async (kind) => {
      const ctx = await cappedGoogleSetup();
      await buildBypass(kind, ctx);

      // The owner-denied send tool stays denied with the cap's own reason code.
      const sendDecision = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_send" });
      expect(sendDecision).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

      // The owner-approved read tool stays allowed through the same bypass.
      const readDecision = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_read" });
      expect(readDecision).toMatchObject({ decision: "allow" });
    },
  );

  it("S5 RUNTIME: the real gateway lists and executes only owner-approved tools; the denied call never reaches secrets or upstream", async () => {
    const ctx = await cappedGoogleSetup();
    await buildBypass("tool_name", ctx);

    const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "s5-owner-cap-signing-secret",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: remote,
    } as never);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: ctx.companyId, agentId: ctx.agent.id, status: "running", contextSnapshot: {}, responsibleUserId: ctx.userA })
      .returning();
    const session = await gateway.createSession({ companyId: ctx.companyId, agentId: ctx.agent.id, runId: run!.id });

    // The REAL listing path is cap-filtered: the read tool is advertised, the send tool is not.
    // The owner's connected account (the responsible user's personal grant) so the
    // approved read can actually execute through the runtime credential path.
    // A personal grant's credential is a user-scoped secret owned by the grant's person.
    const { writeConnectionCredential } = await import("../services/connection-credentials.js");
    const { secret } = await writeConnectionCredential(db, {
      companyId: ctx.companyId,
      connectionName: ctx.instance.name,
      configPath: "oauth.access_token",
      label: "owner google token",
      value: "owner-access-token-value",
      ownerUserId: ctx.userA,
      definitionKey: `test.google.${randomUUID()}`,
    });
    const [ownerGrant] = await db.insert(connectionGrants).values({
      companyId: ctx.companyId,
      connectionId: ctx.instance.id,
      kind: "user",
      subjectUserId: ctx.userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
      createdByUserId: ctx.userA,
    }).returning();
    // The product declares a person's user secret for the connection with the same sync it runs on connect.
    const { syncConnectionCredentialBindings } = await import("../services/connection-credential-bindings.js");
    await syncConnectionCredentialBindings(db, ctx.instance);

    const allListed = await gateway.listToolsForSession(session.token);
    const listed = allListed.filter((tool) => tool.connectionId === ctx.instance.id);
    const readName = listed.find((tool) => tool.name.includes("gmail-read"))?.name;
    expect(readName).toBeTruthy();
    expect(listed.some((tool) => tool.name.includes("gmail-send"))).toBe(false);

    // The owner-approved read call executes through the runtime MCP gateway.
    const readCall = await gateway.executeTool({ sessionToken: session.token, tool: readName!, parameters: {} });
    expect(readCall.status).not.toBe("denied");
    expect(remote.mock.calls.length).toBeGreaterThan(0);

    // The owner-denied send call is refused BEFORE any NEW secret access or upstream fetch.
    const remoteAfterRead = remote.mock.calls.length;
    const secretsAfterRead = (await db.select().from(secretAccessEvents)).length;
    const sendName = readName!.replace("gmail-read", "gmail-send");
    await expect(
      gateway.executeTool({ sessionToken: session.token, tool: sendName, parameters: {} }),
    ).rejects.toMatchObject({ status: 403, reasonCode: "deny_personal_owner_profile" });
    expect(remote.mock.calls.length).toBe(remoteAfterRead); // the denied call reached no upstream
    expect((await db.select().from(secretAccessEvents)).length).toBe(secretsAfterRead);
  });

  it("S5 RH instance: the owner's 4-of-5 ceiling holds in effective profiles and the real gateway listing; a generic include of the fifth changes nothing", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await rhSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const agent = await seedAgent(companyId, { state: agentState() });
    await service.putConnectionInstalls(instance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, instance.id));

    const CEILING = [
      "mdm_granola_status",
      "mdm_list_my_granola_notes",
      "mdm_list_shared_granola_notes",
      "mdm_get_granola_note",
      "mdm_get_granola_transcript",
    ];
    const BEYOND = ["mdm_erase_granola_note", "mdm_write_annotation", "mdm_search_concepts"];
    const catalogByToolName = new Map<string, string>();
    for (const toolName of [...CEILING, ...BEYOND]) {
      const [row] = await db
        .insert(toolCatalogEntries)
        .values({
          companyId,
          applicationId: instance.applicationId,
          connectionId: instance.id,
          entryKind: "tool",
          name: toolName,
          toolName,
          title: toolName,
          riskLevel: toolName.includes("erase") ? "high" : "read",
          isReadOnly: !toolName.includes("erase"),
          status: "active",
          versionHash: randomUUID(),
          schemaHash: randomUUID(),
        })
        .returning();
      catalogByToolName.set(toolName, row!.id);
    }

    // The owner permits exactly FOUR of the five ceiling tools (the install
    // producer already created the canonical app profile + agent binding).
    const [ownerProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${instance.id}`)));
    expect(ownerProfile).toBeTruthy();
    for (const toolName of CEILING.slice(0, 4)) {
      await db.insert(toolProfileEntries).values({
        companyId,
        profileId: ownerProfile!.id,
        selectorType: "catalog_entry",
        catalogEntryId: catalogByToolName.get(toolName)!,
        effect: "include",
      });
    }
    // (The install producer already wrote the agent binding for this profile.)

    // B includes the WHOLE connection (all eight tools) for the same agent.
    const [genericProfile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `generic-b-${randomUUID()}`, name: "B includes everything", status: "active", defaultAction: "deny" })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: genericProfile!.id,
      selectorType: "connection",
      connectionId: instance.id,
      effect: "include",
    });
    await db.insert(toolProfileBindings).values({ companyId, profileId: genericProfile!.id, targetType: "agent", targetId: agent.id });

    const allowed = await decideFor(companyId, agent.id, { connectionId: instance.id, toolName: CEILING[3]! });
    expect(allowed).toMatchObject({ decision: "allow" });
    const fifth = await decideFor(companyId, agent.id, { connectionId: instance.id, toolName: CEILING[4]! });
    expect(fifth).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
    const beyond = await decideFor(companyId, agent.id, { connectionId: instance.id, toolName: BEYOND[0]! });
    expect(beyond).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // Effective profiles project exactly the owner's four for this connection.
    const effective = await service.getEffectiveProfilesForAgent(companyId, agent.id);
    const effectiveForInstance = effective.allowedTools.filter((tool) => tool.connectionId === instance.id).map((tool) => tool.toolName).sort();
    expect(effectiveForInstance).toEqual([...CEILING.slice(0, 4)].sort());

    // The real gateway listing advertises exactly the same four.
    const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "s5-owner-cap-signing-secret",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: remote,
    } as never);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userA })
      .returning();
    const session = await gateway.createSession({ companyId, agentId: agent.id, runId: run!.id });
    const listed = (await gateway.listToolsForSession(session.token)).filter((tool) => tool.connectionId === instance.id);
    const listedToolNames = listed.map((tool) => tool.name).sort();
    expect(listedToolNames).toHaveLength(4);
    for (const toolName of CEILING.slice(0, 4)) {
      expect(listed.some((tool) => tool.name.includes(toolName.replace(/_/g, "-")))).toBe(true);
    }
    expect(listed.some((tool) => tool.name.includes(CEILING[4]!.replace(/_/g, "-")))).toBe(false);
    for (const toolName of BEYOND) {
      expect(listed.some((tool) => tool.name.includes(toolName.replace(/_/g, "-")))).toBe(false);
    }
    void userB;
  });

  it("S5 ABSENCE: a paused or deleted owner profile, or a decoy with copied metadata, denies everything; manual non-instance rows stay uncapped", async () => {
    const ctx = await cappedGoogleSetup();

    // Paused canonical profile: the cap denies ALL tools on the instance.
    await db.update(toolProfiles).set({ status: "paused" }).where(eq(toolProfiles.id, ctx.ownerProfile.id));
    const pausedRead = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_read" });
    expect(pausedRead).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // Missing canonical profile (binding removed too): deny all, no fallback.
    await db.delete(toolProfileBindings).where(eq(toolProfileBindings.profileId, ctx.ownerProfile.id));
    await db.delete(toolProfiles).where(eq(toolProfiles.id, ctx.ownerProfile.id));
    const missingRead = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_read" });
    expect(missingRead).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // A decoy profile with COPIED metadata but a different profileKey never acts as the owner cap.
    const [decoy] = await db
      .insert(toolProfiles)
      .values({
        companyId: ctx.companyId,
        profileKey: `decoy-${randomUUID()}`,
        name: "Decoy",
        status: "active",
        defaultAction: "allow",
        metadata: { source: "app_gallery_finish", connectionId: ctx.instance.id },
      })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: decoy!.id,
      selectorType: "tool_name",
      toolName: "gmail_send",
      effect: "include",
    });
    await db.insert(toolProfileBindings).values({ companyId: ctx.companyId, profileId: decoy!.id, targetType: "agent", targetId: ctx.agent.id });
    const decoySend = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_send" });
    expect(decoySend).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // A manual canonical RH TEMPLATE (valid TECH-7276 template, no managed marker) is NOT an
    // instance and stays uncapped: a generic include still allows its tools (unchanged).
    const [manualApp] = await db
      .insert(toolApplications)
      .values({ companyId: ctx.companyId, applicationKey: `app-${randomUUID()}`, name: "Manual RH", type: "mcp_http", status: "active" })
      .returning();
    const [manualTemplate] = await db
      .insert(toolConnections)
      .values({
        companyId: ctx.companyId,
        applicationId: manualApp!.id,
        name: "rh-mcp-personal",
        uid: `uid-${randomUUID()}`,
        connectionKind: "managed",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "per_user",
        status: "active",
        enabled: true,
        config: { url: "https://rh-mcp.drum-mackarel.ts.net/mcp", identityModel: "personal_only", paperclipDefaultMcpEntry: "rh-mcp" },
        transportConfig: {},
        credentialRefs: [],
        credentialSecretRefs: [],
        createdByUserId: ctx.userA,
      })
      .returning();
    await db.insert(toolCatalogEntries).values({
      companyId: ctx.companyId,
      applicationId: manualApp!.id,
      connectionId: manualTemplate!.id,
      entryKind: "tool",
      name: "mdm_granola_status",
      toolName: "mdm_granola_status",
      title: "Granola status",
      riskLevel: "read",
      isReadOnly: true,
      status: "active",
      versionHash: randomUUID(),
      schemaHash: randomUUID(),
    });
    const [genericProfile] = await db
      .insert(toolProfiles)
      .values({ companyId: ctx.companyId, profileKey: `generic-b-${randomUUID()}`, name: "B manual include", status: "active", defaultAction: "deny" })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: genericProfile!.id,
      selectorType: "connection",
      connectionId: manualTemplate!.id,
      effect: "include",
    });
    await db.insert(toolProfileBindings).values({ companyId: ctx.companyId, profileId: genericProfile!.id, targetType: "agent", targetId: ctx.agent.id });
    const manualDecision = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: manualTemplate!.id, toolName: "mdm_granola_status" });
    expect(manualDecision).toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
  });

  it("S5 producer guard: the owner can still edit their own app profile's other choices (same-key echo allowed)", async () => {
    const ctx = await cappedGoogleSetup();
    const service = svc();

    // The public guard blocks only the app: NAMESPACE claim, not the owner's legitimate edits:
    // a same-key echo plus other-choice edits go through with the REAL fixture-verified actor
    // (the setup's calling user, A) passed as the existing method parameter.
    const updated = await service.updateProfile(
      ctx.ownerProfile.id,
      {
        profileKey: `app:${ctx.instance.id}`,
        name: "Owner renamed profile",
        defaultAction: "deny",
      } as never,
      userActor(ctx.userA),
    );
    expect(updated.profileKey).toBe(`app:${ctx.instance.id}`);
    expect(updated.name).toBe("Owner renamed profile");
    // The cap still works through the edited profile.
    const sendDecision = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_send" });
    expect(sendDecision).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
  });

  it("S5 mint: a legacy connection still mints past the personal-instance token guard; the responsible-user gate keeps its own code", async () => {
    const { companyId, userA, userB } = await seededCompanyWithMembers();
    const service = svc();

    // A legacy (non-personal) connection with the same install/grant/run setup mints
    // PAST the personal-instance guard (it stops at the ordinary broker gate).
    const [manualApp] = await db
      .insert(toolApplications)
      .values({ companyId, applicationKey: `app-${randomUUID()}`, name: "Legacy App", type: "mcp_http", status: "active" })
      .returning();
    const [legacyConn] = await db
      .insert(toolConnections)
      .values({
        companyId,
        applicationId: manualApp!.id,
        name: "Legacy Connection",
        uid: `uid-${randomUUID()}`,
        connectionKind: "custom",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "active",
        enabled: true,
        config: {},
        transportConfig: {},
        credentialRefs: [],
        credentialSecretRefs: [],
      })
      .returning();
    const agent = await seedAgent(companyId, { state: agentState() });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId: legacyConn!.id, targetType: "agent", targetId: agent.id });
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: legacyConn!.id,
      kind: "organization",
      status: "active",
      isDefault: false,
      credentialSecretRefs: [],
    });
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userA })
      .returning();
    await expect(
      service.mintConnectionTokenForAgent({ connectionId: legacyConn!.id, companyId, agentId: agent.id, runId: run!.id, body: {} }),
    ).rejects.toMatchObject({ status: 403, details: { code: "broker_not_enabled" } });

    // The responsible-user gate on a personal instance keeps its original code (the cap
    // does not mask the wrong-user grant route).
    const seed = (await googleSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    await service.putConnectionInstalls(instance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    await db.insert(connectionGrants).values({
      companyId,
      connectionId: instance.id,
      kind: "user",
      subjectUserId: userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [],
      createdByUserId: userA,
    });
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, instance.id));
    const [bRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId: agent.id, status: "running", contextSnapshot: {}, responsibleUserId: userB })
      .returning();
    await expect(
      service.mintConnectionTokenForAgent({ connectionId: instance.id, companyId, agentId: agent.id, runId: bRun!.id, body: {} }),
    ).rejects.toMatchObject({ status: 409, details: { code: "user_authorization_required" } });
    expect(await db.select().from(secretAccessEvents)).toHaveLength(0);
  });

  it("S5 approval path: an owner-denied tool never becomes approvable; an owner-approved ask-first tool still parks and executes after approval", async () => {
    const ctx = await cappedGoogleSetup();
    await buildBypass("tool_name", ctx);

    // The owner's connected account so the runtime credential path is satisfied
    // (this test isolates the APPROVAL path, not the credential gate).
    // A personal grant's credential is a user-scoped secret owned by the grant's person.
    const { writeConnectionCredential } = await import("../services/connection-credentials.js");
    const { secret } = await writeConnectionCredential(db, {
      companyId: ctx.companyId,
      connectionName: ctx.instance.name,
      configPath: "oauth.access_token",
      label: "owner google token",
      value: "owner-access-token-value",
      ownerUserId: ctx.userA,
      definitionKey: `test.google.${randomUUID()}`,
    });
    const [ownerGrant] = await db.insert(connectionGrants).values({
      companyId: ctx.companyId,
      connectionId: ctx.instance.id,
      kind: "user",
      subjectUserId: ctx.userA,
      status: "active",
      isDefault: false,
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
      createdByUserId: ctx.userA,
    }).returning();
    // The product declares a person's user secret for the connection with the same sync it runs on connect.
    const { syncConnectionCredentialBindings } = await import("../services/connection-credential-bindings.js");
    await syncConnectionCredentialBindings(db, ctx.instance);

    // An issue-scoped agent run so the ask-first flow can create approvable requests.
    const [issue] = await db
      .insert(issues)
      .values({ companyId: ctx.companyId, title: "Owner cap issue", status: "todo", priority: "medium" })
      .returning();

    const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: "s5-owner-cap-signing-secret",
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: remote,
    } as never);
    const [run] = await db
      .insert(heartbeatRuns)
      .values({ companyId: ctx.companyId, agentId: ctx.agent.id, status: "running", contextSnapshot: { issueId: issue!.id }, responsibleUserId: ctx.userA })
      .returning();
    const session = await gateway.createSession({ companyId: ctx.companyId, agentId: ctx.agent.id, runId: run!.id });

    const allListed = await gateway.listToolsForSession(session.token);
    const readName = allListed.find((tool) => tool.connectionId === ctx.instance.id && tool.name.includes("gmail-read"))?.name;
    expect(readName).toBeTruthy();
    const sendName = readName!.replace("gmail-read", "gmail-send");

    // Ask-first policies gate BOTH tools: the owner-approved read and the owner-denied send.
    await db.insert(toolPolicies).values([
      {
        companyId: ctx.companyId,
        name: "Ask first for read",
        policyType: "require_approval",
        enabled: true,
        priority: 50,
        selectors: { toolName: "gmail_read" },
        description: "Approval required for gmail_read",
      },
      {
        companyId: ctx.companyId,
        name: "Ask first for send",
        policyType: "require_approval",
        enabled: true,
        priority: 50,
        selectors: { toolName: "gmail_send" },
        description: "Approval required for gmail_send",
      },
    ]);

    const remoteBefore = remote.mock.calls.length;
    const secretsBefore = (await db.select().from(secretAccessEvents)).length;

    // The OWNER-DENIED send tool is denied by the owner cap outright: it never parks
    // as an approvable request, so no later human approval can ever execute it.
    const denied = await gateway
      .executeTool({ sessionToken: session.token, tool: sendName, parameters: {} })
      .catch((error: { status?: number; reasonCode?: string }) => error);
    expect(denied).toMatchObject({ status: 403, reasonCode: "deny_personal_owner_profile" });
    expect(await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, ctx.companyId))).toHaveLength(0);
    expect(remote.mock.calls.length).toBe(remoteBefore);
    expect((await db.select().from(secretAccessEvents)).length).toBe(secretsBefore);

    // The OWNER-APPROVED read tool still parks normally under the same ask-first policy
    // (a pending action request, surfaced to the caller as approval_required).
    const parked = await gateway
      .executeTool({ sessionToken: session.token, tool: readName!, parameters: {} })
      .catch((error: { status?: number; reasonCode?: string }) => error);
    expect(parked).toMatchObject({ status: 409, reasonCode: "approval_required" });
    const [readRequest] = await db
      .select()
      .from(toolActionRequests)
      .where(and(eq(toolActionRequests.companyId, ctx.companyId), eq(toolActionRequests.status, "pending")))
      .limit(1);
    expect(readRequest).toBeTruthy();

    // A human approves the read request and it executes (the cap never blocks
    // owner-approved tools through the approval path).
    await gateway.approveActionRequest({
      companyId: ctx.companyId,
      actionRequestId: readRequest!.id,
      actor: { userId: ctx.userA },
    });
    const [settled] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, readRequest!.id))
      .limit(1);
    expect(["executed", "approved", "executing"]).toContain(settled?.status);
    expect(remote.mock.calls.length).toBeGreaterThan(remoteBefore); // the approved read ran
  });

  const ownerReadInclude = (profileId: string) =>
    and(eq(toolProfileEntries.profileId, profileId), eq(toolProfileEntries.toolName, "gmail_read"), eq(toolProfileEntries.effect, "include"));

  it("S5 CONDITIONS: a valid argument-restricted owner include enforces actual arguments; the potential stays advertised and no generic include widens it", async () => {
    const ctx = await cappedGoogleSetup();
    await buildBypass("tool_name", ctx); // B's unconditional generic include for the same agent

    // A VALID argument condition (the schema's fieldEquals shape) restricts the owner's
    // read include to safe bodies.
    await db
      .update(toolProfileEntries)
      .set({ conditions: { arguments: { fieldEquals: { body: "safe" } } } })
      .where(ownerReadInclude(ctx.ownerProfile.id));

    const matching = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
    });
    expect(matching).toMatchObject({ decision: "allow" });
    const mismatched = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "unsafe" },
    });
    expect(mismatched).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // The conditional potential stays advertised statically (the invoke enforces the
    // actual arguments); the still-denied send tool does not.
    const effective = await svc().getEffectiveProfilesForAgent(ctx.companyId, ctx.agent.id);
    expect(effective.allowedToolNames).toContain("gmail_read");
    expect(effective.allowedToolNames).not.toContain("gmail_send");

    // A valid time-window-only include is matched by arguments but outside the window.
    await db
      .update(toolProfileEntries)
      .set({ conditions: { timeWindow: { startAt: "2099-01-01T00:00:00.000Z" } } })
      .where(ownerReadInclude(ctx.ownerProfile.id));
    const notYetInWindow = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
    });
    expect(notYetInWindow).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // A conditional owner EXCLUDE denies only the excluded arguments; the potential stays advertised.
    await db.update(toolProfileEntries).set({ conditions: null }).where(ownerReadInclude(ctx.ownerProfile.id));
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: ctx.ownerProfile.id,
      selectorType: "tool_name",
      toolName: "gmail_read",
      effect: "exclude",
      conditions: { arguments: { fieldEquals: { body: "unsafe" } } },
    });
    const excluded = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "unsafe" },
    });
    expect(excluded).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
    const notExcluded = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
    });
    expect(notExcluded).toMatchObject({ decision: "allow" });
  });

  it.each([
    ["string", "not-an-object"],
    ["array", ["not", "an", "object"]],
    ["schema-invalid object", { args: { body: "safe" } }], // the shape the public validator rejects
  ] as const)(
    "S5 CONDITIONS (%s): malformed owner-include conditions fail closed in the runtime decision and the static projection",
    async (_label, malformed) => {
      const ctx = await cappedGoogleSetup();

      // Seeded directly in the DB (the public validators reject these) to exercise fail-closed.
      await db.update(toolProfileEntries).set({ conditions: malformed as never }).where(ownerReadInclude(ctx.ownerProfile.id));

      const denied = await decideFor(ctx.companyId, ctx.agent.id, {
        connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
      });
      expect(denied).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

      // The invalid constraint is not advertised: the static projection removes the tool.
      const effective = await svc().getEffectiveProfilesForAgent(ctx.companyId, ctx.agent.id);
      expect(effective.allowedToolNames).not.toContain("gmail_read");
      expect(effective.allowedToolNames).not.toContain("gmail_send");
    },
  );

  it("S5 CONDITIONS (short-circuit): a default-allow profile, an early valid include, or a malformed exclude cannot hide an invalid entry", async () => {
    const ctx = await cappedGoogleSetup();

    // (a) defaultAction ALLOW plus a malformed include: the default-allow OR must not skip validation.
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, ctx.ownerProfile.id));
    await db.update(toolProfileEntries).set({ conditions: "not-an-object" as never }).where(ownerReadInclude(ctx.ownerProfile.id));
    const deniedDefaultAllow = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
    });
    expect(deniedDefaultAllow).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
    expect((await svc().getEffectiveProfilesForAgent(ctx.companyId, ctx.agent.id)).allowedToolNames).not.toContain("gmail_read");

    // (b) an EARLY valid include plus a LATER malformed include: .some() must not stop at the early match.
    await db.update(toolProfiles).set({ defaultAction: "deny" }).where(eq(toolProfiles.id, ctx.ownerProfile.id));
    await db.update(toolProfileEntries).set({ conditions: null }).where(ownerReadInclude(ctx.ownerProfile.id));
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: ctx.ownerProfile.id,
      selectorType: "tool_name",
      toolName: "gmail_read",
      effect: "include",
      conditions: ["not", "an", "object"] as never,
    });
    const deniedLaterMalformed = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
    });
    expect(deniedLaterMalformed).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
    expect((await svc().getEffectiveProfilesForAgent(ctx.companyId, ctx.agent.id)).allowedToolNames).not.toContain("gmail_read");

    // (c) a valid include plus a MALFORMED EXCLUDE: fail closed too.
    await db.delete(toolProfileEntries).where(and(eq(toolProfileEntries.profileId, ctx.ownerProfile.id), eq(toolProfileEntries.effect, "include")));
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: ctx.ownerProfile.id,
      selectorType: "tool_name",
      toolName: "gmail_read",
      effect: "include",
    });
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: ctx.ownerProfile.id,
      selectorType: "tool_name",
      toolName: "gmail_read",
      effect: "exclude",
      conditions: { args: { body: "safe" } } as never,
    });
    const deniedMalformedExclude = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id, toolName: "gmail_read", arguments: { body: "safe" },
    });
    expect(deniedMalformedExclude).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
    expect((await svc().getEffectiveProfilesForAgent(ctx.companyId, ctx.agent.id)).allowedToolNames).not.toContain("gmail_read");
  });

  it("S5 CATALOG AUTHORITY: the owner cap trusts the catalog row's raw tool name, never the caller's upstreamToolName hint", async () => {
    const { companyId, userA } = await seededCompanyWithMembers();
    const service = svc();
    const seed = (await rhSeed(companyId))!;
    const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
    const agent = await seedAgent(companyId, { state: agentState() });
    await service.putConnectionInstalls(instance.id, { installs: [{ targetType: "agent", targetId: agent.id }] }, userActor(userA));
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, instance.id));

    const CEILING = [
      "mdm_granola_status",
      "mdm_list_my_granola_notes",
      "mdm_list_shared_granola_notes",
      "mdm_get_granola_note",
      "mdm_get_granola_transcript",
    ];
    const catalogByToolName = new Map<string, string>();
    for (const toolName of [...CEILING, "mdm_erase_granola_note"]) {
      const [row] = await db
        .insert(toolCatalogEntries)
        .values({
          companyId,
          applicationId: instance.applicationId,
          connectionId: instance.id,
          entryKind: "tool",
          name: toolName,
          toolName,
          title: toolName,
          riskLevel: toolName.includes("erase") ? "high" : "read",
          isReadOnly: !toolName.includes("erase"),
          status: "active",
          versionHash: randomUUID(),
          schemaHash: randomUUID(),
        })
        .returning();
      catalogByToolName.set(toolName, row!.id);
    }

    // The owner's canonical profile allows by default (so inclusion is not the gate here);
    // B's generic connection include makes the general decision allow.
    const [ownerProfile] = await db
      .select()
      .from(toolProfiles)
      .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, `app:${instance.id}`)));
    expect(ownerProfile).toBeTruthy();
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.id, ownerProfile!.id));
    const [genericProfile] = await db
      .insert(toolProfiles)
      .values({ companyId, profileKey: `generic-b-${randomUUID()}`, name: "B includes everything", status: "active", defaultAction: "deny" })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId,
      profileId: genericProfile!.id,
      selectorType: "connection",
      connectionId: instance.id,
      effect: "include",
    });
    await db.insert(toolProfileBindings).values({ companyId, profileId: genericProfile!.id, targetType: "agent", targetId: agent.id });

    // A FAKE hint claiming an approved ceiling tool must not lift the static read ceiling
    // for the ACTUAL beyond-ceiling catalog row (the catalog row is authoritative).
    const fakeHint = await decideFor(companyId, agent.id, {
      connectionId: instance.id,
      toolName: "mdm_erase_granola_note",
      catalogEntryId: catalogByToolName.get("mdm_erase_granola_note")!,
      upstreamToolName: "mdm_get_granola_note",
    });
    expect(fakeHint).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // A WRONG hint on an actually-permitted catalog row must not incorrectly deny it.
    const wrongHint = await decideFor(companyId, agent.id, {
      connectionId: instance.id,
      toolName: "mdm_get_granola_note",
      catalogEntryId: catalogByToolName.get("mdm_get_granola_note")!,
      upstreamToolName: "not_a_real_tool",
    });
    expect(wrongHint).toMatchObject({ decision: "allow" });

    // The static projection agrees: exactly the five ceiling tools this fixture's simulated
    // upstream discovers (the real ceiling is 10 raw names; this fixture only exposes Granola).
    const effective = await service.getEffectiveProfilesForAgent(companyId, agent.id);
    const effectiveForInstance = effective.allowedTools.filter((tool) => tool.connectionId === instance.id).map((tool) => tool.toolName).sort();
    expect(effectiveForInstance).toEqual([...CEILING].sort());
  });

  it("S5 CATALOG AUTHORITY (Google): a spoofed tool_name claim never matches the owner cap; the catalog row's identity decides", async () => {
    // Google (no static RH5 read ceiling): agentMayUseConnectionTool is always true here, so
    // this isolates the include-matching authority — only the actual catalog row's toolName /
    // name may match the owner profile's tool_name includes, never the request-supplied name.
    const ctx = await cappedGoogleSetup();

    // A spoof: claim the owner-approved name (gmail_read) while pointing catalogEntryId at the
    // DENIED send tool. The general path allows via the claimed name; the owner cap must decide
    // by the actual catalog row (gmail_send), so the read-named include never matches and the
    // send call is denied with the cap's own reason.
    const spoof = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.sendEntry.id,
      toolName: "gmail_read",
    });
    expect(spoof).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });

    // The honest shape on the same connection: the read catalog row plus its actual name allows.
    const read = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.readEntry.id,
      toolName: "gmail_read",
    });
    expect(read).toMatchObject({ decision: "allow" });

    // The catalog row's display name is authoritative identity too: an owner include that
    // names the row's `name` (not its raw toolName) admits that row.
    const [displayEntry] = await db
      .insert(toolCatalogEntries)
      .values({
        companyId: ctx.companyId,
        applicationId: ctx.instance.applicationId,
        connectionId: ctx.instance.id,
        entryKind: "tool",
        name: "Gmail display label",
        toolName: "gmail_display",
        title: "Gmail display label",
        riskLevel: "read",
        isReadOnly: true,
        status: "active",
        versionHash: randomUUID(),
        schemaHash: randomUUID(),
      })
      .returning();
    await db.insert(toolProfileEntries).values({
      companyId: ctx.companyId,
      profileId: ctx.ownerProfile.id,
      selectorType: "tool_name",
      toolName: "Gmail display label",
      effect: "include",
    });
    const displayNameDecision = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: displayEntry!.id,
      toolName: "Gmail display label",
    });
    expect(displayNameDecision).toMatchObject({ decision: "allow" });

    // Strict-personal General raw-name alias: a namespaced request name still matches the
    // owner's raw-named include via the server-derived catalog raw name (any connection; server-derived).
    const namespaced = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.readEntry.id,
      toolName: "mcp.google:gmail-read",
    });
    expect(namespaced).toMatchObject({ decision: "allow", reasonCode: "allow_profile" });
  });

  it("S5 TRUST DEFER: an owner-capped deny never records a trust-rule hit; only a cap-passed allow does", async () => {
    const ctx = await cappedGoogleSetup();
    const trustAudits = () =>
      db.select().from(toolAccessAuditEvents).where(and(
        eq(toolAccessAuditEvents.companyId, ctx.companyId),
        eq(toolAccessAuditEvents.action, "tool_access.trust_rule_used"),
        eq(toolAccessAuditEvents.actorType, "agent"),
        eq(toolAccessAuditEvents.actorId, ctx.agent.id),
      ));
    const trustEvents = () =>
      db.select().from(toolCallEvents).where(and(
        eq(toolCallEvents.companyId, ctx.companyId),
        eq(toolCallEvents.eventType, "trust_rule_used"),
        eq(toolCallEvents.agentId, ctx.agent.id),
      ));
    const ruleConfigOf = async (policyId: string) => {
      const [row] = await db.select().from(toolPolicies).where(eq(toolPolicies.id, policyId));
      return ((row!.config ?? {}) as { trustRule?: { hitCount?: number; lastHitAt?: string | null } }).trustRule;
    };

    // An owner-promoted trust rule for the DENIED send tool (the real promoted-row shape).
    const [sendRule] = await db.insert(toolPolicies).values({
      companyId: ctx.companyId,
      name: `Trust gmail_send ${randomUUID().slice(0, 8)}`,
      description: "Owner-promoted trust rule for the send tool.",
      policyType: "trust_rule",
      priority: 40,
      enabled: true,
      selectors: { connectionId: ctx.instance.id, toolName: "gmail_send" },
      config: { trustRule: { hitCount: 0, lastHitAt: null } },
      createdByUserId: ctx.userA,
    }).returning();

    // A real invocation (consumeRateLimit: true) of the send tool via its actual catalog row: the
    // trust rule would allow, but the owner cap denies — and a denied call must not record the hit.
    const sendDecision = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.sendEntry.id,
      toolName: "gmail_send",
      consumeRateLimit: true,
    });
    expect(sendDecision).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
    expect(await ruleConfigOf(sendRule!.id)).toEqual({ hitCount: 0, lastHitAt: null });
    expect(await trustAudits()).toHaveLength(0);
    expect(await trustEvents()).toHaveLength(0);

    // The same shape for the owner-approved read tool: the trust rule really matches in the
    // general path (exact allow_trust_rule reason — not the profile fallback), the cap passes,
    // and exactly one hit is recorded.
    const [readRule] = await db.insert(toolPolicies).values({
      companyId: ctx.companyId,
      name: `Trust gmail_read ${randomUUID().slice(0, 8)}`,
      description: "Owner-promoted trust rule for the read tool.",
      policyType: "trust_rule",
      priority: 40,
      enabled: true,
      selectors: { connectionId: ctx.instance.id, toolName: "gmail_read" },
      config: { trustRule: { hitCount: 0, lastHitAt: null } },
      createdByUserId: ctx.userA,
    }).returning();

    const readDecision = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.readEntry.id,
      toolName: "gmail_read",
      consumeRateLimit: true,
    });
    expect(readDecision).toMatchObject({ decision: "allow", reasonCode: "allow_trust_rule", matchedPolicyIds: [readRule!.id] });
    const readRuleTrust = await ruleConfigOf(readRule!.id);
    expect(readRuleTrust).toMatchObject({ hitCount: 1 });
    expect(typeof readRuleTrust?.lastHitAt).toBe("string");

    const [trustAudit] = await trustAudits();
    expect(trustAudit).toMatchObject({
      outcome: "success",
      reasonCode: "allow_trust_rule",
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.readEntry.id,
      details: { policyId: readRule!.id, agentId: ctx.agent.id, hitCount: 1 },
    });
    const events = await trustEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "trust_rule_used",
      decision: "allow",
      outcome: "success",
      reasonCode: "allow_trust_rule",
      toolName: "gmail_read",
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.readEntry.id,
      matchedPolicyIds: [readRule!.id],
    });

    // A preview (consumeRateLimit unset) re-allows without recording another hit.
    const preview = await decideFor(ctx.companyId, ctx.agent.id, {
      connectionId: ctx.instance.id,
      catalogEntryId: ctx.readEntry.id,
      toolName: "gmail_read",
    });
    expect(preview).toMatchObject({ decision: "allow", reasonCode: "allow_trust_rule" });
    expect(await ruleConfigOf(readRule!.id)).toMatchObject({ hitCount: 1 });
    expect(await trustAudits()).toHaveLength(1);
    expect(await trustEvents()).toHaveLength(1);
  });

  it.each([
    ["updateProfile", "name-changed"],
    ["deleteProfile", "force-delete"],
    ["addProfileEntry", "new-entry"],
    ["updateProfileEntry", "entry-excluded"],
    ["deleteProfileEntry", "entry-removed"],
    ["bindProfile", "new-binding"],
    ["unbindProfile", "binding-removed"],
    ["reviewProfileNewTools", "review-tamper"],
  ] as const)(
    "S5 PROFILE MUTATORS (%s): an omitted actor cannot mutate the owner's canonical app profile (403, DB unchanged)",
    async (method) => {
      const ctx = await cappedGoogleSetup();
      const service = svc();

      // The setup's own canonical profile row, its read include, and its agent binding.
      const [includeEntry] = await db
        .select()
        .from(toolProfileEntries)
        .where(and(
          eq(toolProfileEntries.profileId, ctx.ownerProfile.id),
          eq(toolProfileEntries.toolName, "gmail_read"),
          eq(toolProfileEntries.effect, "include"),
        ));
      const [agentBinding] = await db
        .select()
        .from(toolProfileBindings)
        .where(and(
          eq(toolProfileBindings.profileId, ctx.ownerProfile.id),
          eq(toolProfileBindings.targetType, "agent"),
          eq(toolProfileBindings.targetId, ctx.agent.id),
        ));
      expect(includeEntry).toBeTruthy();
      expect(agentBinding).toBeTruthy();

      const snapshot = async () => [
        await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, ctx.companyId)).orderBy(toolProfiles.id),
        await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.companyId, ctx.companyId)).orderBy(toolProfileEntries.id),
        await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.companyId, ctx.companyId)).orderBy(toolProfileBindings.id),
      ];
      const before = await snapshot();

      // Every mutator is invoked with the actor OMITTED (undefined): the original
      // fail-closed guard must refuse, whoever the caller would have been.
      switch (method) {
        case "updateProfile":
          await expect(
            service.updateProfile(ctx.ownerProfile.id, { name: "Tampered by no one" } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "deleteProfile":
          await expect(
            service.deleteProfile(ctx.ownerProfile.id, { force: true } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "addProfileEntry":
          await expect(
            service.addProfileEntry(ctx.ownerProfile.id, { selectorType: "tool_name", toolName: "gmail_tamper", effect: "include" } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "updateProfileEntry":
          await expect(
            service.updateProfileEntry(includeEntry!.id, { effect: "exclude" } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "deleteProfileEntry":
          await expect(
            service.deleteProfileEntry(includeEntry!.id),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "bindProfile":
          await expect(
            service.bindProfile(ctx.ownerProfile.id, { targetType: "agent", targetId: ctx.agent.id } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "unbindProfile":
          await expect(
            service.unbindProfile(ctx.ownerProfile.id, { targetType: "agent", targetId: ctx.agent.id } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
        case "reviewProfileNewTools":
          await expect(
            service.reviewProfileNewTools(ctx.ownerProfile.id, { decisions: [{ catalogEntryId: ctx.sendEntry.id, decision: "allow" }] } as never),
          ).rejects.toMatchObject({ status: 403, details: { code: "personal_instance_owner_required" } });
          break;
      }

      // Nothing was written: profiles, entries, and bindings are byte-identical.
      expect(await snapshot()).toEqual(before);
    },
  );

  it("S5 scope: the owner cap applies to agent actors only; a human user's decision is unchanged", async () => {
    const ctx = await cappedGoogleSetup();
    await buildBypass("tool_name", ctx);

    // A HUMAN actor's preview decision is never the owner cap (the cap is agent-only).
    const userDecision = await toolAccessPolicyService(db).decide({
      companyId: ctx.companyId,
      actor: { actorType: "user", actorId: ctx.userB },
      request: { connectionId: ctx.instance.id, toolName: "gmail_send", arguments: {} },
    });
    expect(userDecision.reasonCode).not.toBe("deny_personal_owner_profile");
    // The agent actor on the same request is the cap.
    const agentDecision = await decideFor(ctx.companyId, ctx.agent.id, { connectionId: ctx.instance.id, toolName: "gmail_send" });
    expect(agentDecision).toMatchObject({ decision: "deny", reasonCode: "deny_personal_owner_profile" });
  });

  describe("TECH-8349: never show personal connection with no credential as connected", () => {
    it("1. /finish returns 409 oauth_sign_in_required with exact message; row not active and no profile created", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;
      const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

      await expect(
        service.finishGalleryAppConnection(
          companyId,
          instance.id,
          { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [] } },
          userActor(userA),
        ),
      ).rejects.toMatchObject({
        status: 409,
        message:
          "Sign in to this app before saving permissions. Click Connect to finish signing in, then set your actions.",
        details: { code: "oauth_sign_in_required" },
      });

      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, instance.id));
      expect(row!.status).not.toBe("active");
      const profiles = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${instance.id}`));
      expect(profiles).toHaveLength(0);
    });

    it("2. /finish succeeds once an owner grant with an oauth.access_token ref exists", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;
      const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

      const { writeConnectionCredential } = await import("../services/connection-credentials.js");
      const { secret } = await writeConnectionCredential(db, {
        companyId,
        connectionName: instance.name,
        configPath: "oauth.access_token",
        label: "owner google token",
        value: "owner-access-token-value",
        ownerUserId: userA,
        definitionKey: `test.google.${randomUUID()}`,
      });
      await db.insert(connectionGrants).values({
        companyId,
        connectionId: instance.id,
        kind: "user",
        subjectUserId: userA,
        status: "active",
        isDefault: false,
        credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
        createdByUserId: userA,
      });

      const result = await service.finishGalleryAppConnection(
        companyId,
        instance.id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [] } },
        userActor(userA),
      );
      expect(result.connection.status).toBe("active");
      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, instance.id));
      expect(row!.status).toBe("active");
    });

    it("3. /finish on an API-key/org connection and on a manual public OAuth connection with no grant still works", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();

      // (a) API-key/org connection
      const [apiKeyApp] = await db.insert(toolApplications).values({ companyId, applicationKey: `app-${randomUUID()}`, name: "API Key App", type: "mcp_http", status: "active" }).returning();
      const [apiKeyConn] = await db.insert(toolConnections).values({
        companyId,
        applicationId: apiKeyApp!.id,
        name: "API Key Conn",
        uid: `uid-${randomUUID()}`,
        connectionKind: "custom",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "api_key",
        credentialPolicy: "shared",
        status: "draft",
        enabled: true,
        config: { url: "https://example.com/mcp" },
        transportConfig: { url: "https://example.com/mcp" },
        credentialRefs: [],
        credentialSecretRefs: [],
      }).returning();

      const apiKeyResult = await service.finishGalleryAppConnection(
        companyId,
        apiKeyConn!.id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" },
        userActor(userA),
      );
      expect(apiKeyResult.connection.status).toBe("active");

      // (b) Manual public OAuth connection with no grant
      const [manualApp] = await db.insert(toolApplications).values({ companyId, applicationKey: `app-${randomUUID()}`, name: "Manual OAuth App", type: "mcp_http", status: "active" }).returning();
      const [manualConn] = await db.insert(toolConnections).values({
        companyId,
        applicationId: manualApp!.id,
        name: "Manual OAuth Conn",
        uid: `uid-${randomUUID()}`,
        connectionKind: "custom",
        ownership: "customer",
        transport: "mcp_remote",
        authKind: "oauth",
        credentialPolicy: "shared",
        status: "draft",
        enabled: true,
        config: { url: "https://example.com/mcp" },
        transportConfig: { url: "https://example.com/mcp" },
        credentialRefs: [],
        credentialSecretRefs: [],
      }).returning();

      const manualResult = await service.finishGalleryAppConnection(
        companyId,
        manualConn!.id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents" },
        userActor(userA),
      );
      expect(manualResult.connection.status).toBe("active");
    });

    it("4. Gateway, owner is responsible and has no grant: rejects with user_authorization_required, and health becomes missing_secret with message", async () => {
      const ctx = await cappedGoogleSetup();
      const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
      const gateway = createToolGatewayService(db, {
        toolActionSigningSecret: "s5-owner-cap-signing-secret",
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: remote,
      } as never);

      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: ctx.companyId, agentId: ctx.agent.id, status: "running", contextSnapshot: {}, responsibleUserId: ctx.userA })
        .returning();
      const session = await gateway.createSession({ companyId: ctx.companyId, agentId: ctx.agent.id, runId: run!.id });

      const allListed = await gateway.listToolsForSession(session.token);
      const readName = allListed.find((tool) => tool.connectionId === ctx.instance.id && tool.name.includes("gmail-read"))?.name;
      expect(readName).toBeTruthy();

      await expect(
        gateway.executeTool({ sessionToken: session.token, tool: readName!, parameters: {} }),
      ).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

      const [updated] = await db.select().from(toolConnections).where(eq(toolConnections.id, ctx.instance.id));
      expect(updated!.healthStatus).toBe("missing_secret");
      expect(updated!.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");
    });

    it("5. Gateway, responsible user ≠ owner and the owner HAS a grant: rejects, and health is UNCHANGED", async () => {
      const ctx = await cappedGoogleSetup();
      // Owner A has a grant with token
      const { writeConnectionCredential } = await import("../services/connection-credentials.js");
      const { secret } = await writeConnectionCredential(db, {
        companyId: ctx.companyId,
        connectionName: ctx.instance.name,
        configPath: "oauth.access_token",
        label: "owner google token",
        value: "owner-access-token-value",
        ownerUserId: ctx.userA,
        definitionKey: `test.google.${randomUUID()}`,
      });
      await db.insert(connectionGrants).values({
        companyId: ctx.companyId,
        connectionId: ctx.instance.id,
        kind: "user",
        subjectUserId: ctx.userA,
        status: "active",
        isDefault: false,
        credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
        createdByUserId: ctx.userA,
      });
      // Set initial healthStatus to "ok"
      await db.update(toolConnections).set({ healthStatus: "ok", healthMessage: "Connected" }).where(eq(toolConnections.id, ctx.instance.id));

      const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
      const gateway = createToolGatewayService(db, {
        toolActionSigningSecret: "s5-owner-cap-signing-secret",
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: remote,
      } as never);

      // Responsible user is userB (≠ owner userA)
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: ctx.companyId, agentId: ctx.agent.id, status: "running", contextSnapshot: {}, responsibleUserId: ctx.userB })
        .returning();
      const session = await gateway.createSession({ companyId: ctx.companyId, agentId: ctx.agent.id, runId: run!.id });

      const allListed = await gateway.listToolsForSession(session.token);
      const readName = allListed.find((tool) => tool.connectionId === ctx.instance.id && tool.name.includes("gmail-read"))?.name;
      expect(readName).toBeTruthy();

      await expect(
        gateway.executeTool({ sessionToken: session.token, tool: readName!, parameters: {} }),
      ).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

      const [updated] = await db.select().from(toolConnections).where(eq(toolConnections.id, ctx.instance.id));
      expect(updated!.healthStatus).toBe("ok");
      expect(updated!.healthMessage).toBe("Connected");
    });

    it("5b. Gateway, responsible user ≠ owner and the owner HAS NO grant: rejects, and health is UNCHANGED", async () => {
      const ctx = await cappedGoogleSetup();
      // Owner A has NO grant.
      // Set initial healthStatus to "ok"
      await db.update(toolConnections).set({ healthStatus: "ok", healthMessage: "Connected" }).where(eq(toolConnections.id, ctx.instance.id));

      const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
      const gateway = createToolGatewayService(db, {
        toolActionSigningSecret: "s5-owner-cap-signing-secret",
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: remote,
      } as never);

      // Responsible user is userB (≠ owner userA)
      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: ctx.companyId, agentId: ctx.agent.id, status: "running", contextSnapshot: {}, responsibleUserId: ctx.userB })
        .returning();
      const session = await gateway.createSession({ companyId: ctx.companyId, agentId: ctx.agent.id, runId: run!.id });

      const allListed = await gateway.listToolsForSession(session.token);
      const readName = allListed.find((tool) => tool.connectionId === ctx.instance.id && tool.name.includes("gmail-read"))?.name;
      expect(readName).toBeTruthy();

      await expect(
        gateway.executeTool({ sessionToken: session.token, tool: readName!, parameters: {} }),
      ).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

      const [updated] = await db.select().from(toolConnections).where(eq(toolConnections.id, ctx.instance.id));
      // Non-owner run must NOT mutate connection health to missing_secret even when owner has no grant
      expect(updated!.healthStatus).toBe("ok");
      expect(updated!.healthMessage).toBe("Connected");
    });

    it("6. Gateway idempotence: two failing calls produce exactly one health update", async () => {
      const ctx = await cappedGoogleSetup();
      const remote = vi.fn(async (_url: string, init?: RequestInit) => mcpRemoteResponse(init));
      const gateway = createToolGatewayService(db, {
        toolActionSigningSecret: "s5-owner-cap-signing-secret",
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: remote,
      } as never);

      const [run] = await db
        .insert(heartbeatRuns)
        .values({ companyId: ctx.companyId, agentId: ctx.agent.id, status: "running", contextSnapshot: {}, responsibleUserId: ctx.userA })
        .returning();
      const session = await gateway.createSession({ companyId: ctx.companyId, agentId: ctx.agent.id, runId: run!.id });

      const allListed = await gateway.listToolsForSession(session.token);
      const readName = allListed.find((tool) => tool.connectionId === ctx.instance.id && tool.name.includes("gmail-read"))?.name;
      expect(readName).toBeTruthy();

      await expect(
        gateway.executeTool({ sessionToken: session.token, tool: readName!, parameters: {} }),
      ).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

      const [firstUpdated] = await db.select().from(toolConnections).where(eq(toolConnections.id, ctx.instance.id));
      expect(firstUpdated!.healthStatus).toBe("missing_secret");

      const auditEvents1 = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, ctx.companyId),
            eq(activityLog.action, "tool_gateway.personal_credential_resolution_error"),
          ),
        );
      expect(auditEvents1).toHaveLength(1);

      // Second failing call
      await expect(
        gateway.executeTool({ sessionToken: session.token, tool: readName!, parameters: {} }),
      ).rejects.toMatchObject({ status: 403, reasonCode: "user_authorization_required" });

      const auditEvents2 = await db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, ctx.companyId),
            eq(activityLog.action, "tool_gateway.personal_credential_resolution_error"),
          ),
        );
      expect(auditEvents2).toHaveLength(1);
    });

    it("7. listAppsNeedingAttention includes credential-less instance and excludes healthy instance", async () => {
      const { companyId, userA, userB } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;

      // Instance 1: userA has no grant
      const instance1 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
      await db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "ok" }).where(eq(toolConnections.id, instance1.id));

      // Instance 2: userB has a grant with token
      const instance2 = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userB);
      await db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "ok" }).where(eq(toolConnections.id, instance2.id));
      const { writeConnectionCredential } = await import("../services/connection-credentials.js");
      const { secret } = await writeConnectionCredential(db, {
        companyId,
        connectionName: instance2.name,
        configPath: "oauth.access_token",
        label: "owner google token",
        value: "owner-access-token-value",
        ownerUserId: userB,
        definitionKey: `test.google.${randomUUID()}`,
      });
      await db.insert(connectionGrants).values({
        companyId,
        connectionId: instance2.id,
        kind: "user",
        subjectUserId: userB,
        status: "active",
        isDefault: false,
        credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
        createdByUserId: userB,
      });

      const attention = await service.listAppsNeedingAttention(companyId);
      expect(attention.totals.health).toBe(1);
      const app1 = attention.apps.find((a) => a.connection.id === instance1.id);
      expect(app1).toBeDefined();
      expect(app1!.healthNeedsAttention).toBe(true);
      expect(app1!.reasons).toContain("health");
      expect(app1!.connection.healthStatus).toBe("missing_secret");
      expect(app1!.connection.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");

      const app2 = attention.apps.find((a) => a.connection.id === instance2.id);
      expect(app2).toBeUndefined();

      // Verify DB row remains unchanged (stays read-only)
      const [row1] = await db.select().from(toolConnections).where(eq(toolConnections.id, instance1.id));
      expect(row1!.healthStatus).toBe("ok");
    });

    it("8. get/listConnections with a viewer are annotated; without a viewer they return raw values", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;
      const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
      // userA has no grant. Set DB healthStatus to "ok".
      await db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "ok", healthMessage: "All good" }).where(eq(toolConnections.id, instance.id));

      // With viewer
      const withViewerGet = await service.getConnection(instance.id, companyId, userA);
      expect(withViewerGet.healthStatus).toBe("missing_secret");
      expect(withViewerGet.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");
      expect(withViewerGet.requiresReauthorization).toBe(true);

      const withViewerList = await service.listConnections(companyId, userA);
      const itemWithViewer = withViewerList.find((c) => c.id === instance.id);
      expect(itemWithViewer!.healthStatus).toBe("missing_secret");
      expect(itemWithViewer!.requiresReauthorization).toBe(true);

      // Without viewer
      const withoutViewerGet = await service.getConnection(instance.id, companyId, undefined);
      expect(withoutViewerGet.healthStatus).toBe("ok");
      expect(withoutViewerGet.healthMessage).toBe("All good");

      const withoutViewerList = await service.listConnections(companyId, undefined);
      const itemWithoutViewer = withoutViewerList.find((c) => c.id === instance.id);
      expect(itemWithoutViewer!.healthStatus).toBe("ok");
    });

    it("9. The sweep guard doesn't write ok, and the exact status is asserted", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;
      const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
      // userA has no grant. Set initial DB healthStatus to "ok".
      await db.update(toolConnections).set({ status: "active", enabled: true, healthStatus: "ok" }).where(eq(toolConnections.id, instance.id));

      await expect(
        service.checkHealth(instance.id, userActor(userA)),
      ).rejects.toMatchObject({
        status: 422,
        details: { code: "oauth_sign_in_required" },
      });

      const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, instance.id));
      expect(row!.healthStatus).toBe("missing_secret");
      expect(row!.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");
    });

    it("8b. Ownerless personal instances are annotated as missing_secret with viewer and appear in listAppsNeedingAttention", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;
      const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);
      // Simulate legacy or orphaned ownerless row by clearing createdByUserId
      await db.update(toolConnections).set({
        createdByUserId: null,
        status: "active",
        enabled: true,
        healthStatus: "ok",
        healthMessage: "All good",
      }).where(eq(toolConnections.id, instance.id));

      // 1. With viewer, getConnection & listConnections annotate as missing_secret
      const withViewerGet = await service.getConnection(instance.id, companyId, userA);
      expect(withViewerGet.healthStatus).toBe("missing_secret");
      expect(withViewerGet.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");
      expect(withViewerGet.requiresReauthorization).toBe(true);

      const withViewerList = await service.listConnections(companyId, userA);
      const itemWithViewer = withViewerList.find((c) => c.id === instance.id);
      expect(itemWithViewer!.healthStatus).toBe("missing_secret");
      expect(itemWithViewer!.requiresReauthorization).toBe(true);

      // 2. Without viewer, raw un-annotated DB values are returned
      const withoutViewerGet = await service.getConnection(instance.id, companyId, undefined);
      expect(withoutViewerGet.healthStatus).toBe("ok");

      // 3. listAppsNeedingAttention includes the ownerless personal instance
      const needingAttention = await service.listAppsNeedingAttention(companyId);
      const appItem = needingAttention.apps.find((a) => a.connection.id === instance.id);
      expect(appItem).toBeTruthy();
      expect(appItem!.reasons).toContain("health");
      expect(appItem!.connection.healthStatus).toBe("missing_secret");
      expect(appItem!.connection.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");
    });

    it("10. finishGalleryAppConnection returns createdProfile: true for fresh profile and false when profile exists", async () => {
      const { companyId, userA } = await seededCompanyWithMembers();
      const service = svc();
      const seed = (await googleSeed(companyId))!;
      const instance = await service.ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

      const { writeConnectionCredential } = await import("../services/connection-credentials.js");
      const { secret } = await writeConnectionCredential(db, {
        companyId,
        connectionName: instance.name,
        configPath: "oauth.access_token",
        label: "owner google token",
        value: "owner-access-token-value",
        ownerUserId: userA,
        definitionKey: `test.google.${randomUUID()}`,
      });
      await db.insert(connectionGrants).values({
        companyId,
        connectionId: instance.id,
        kind: "user",
        subjectUserId: userA,
        status: "active",
        isDefault: false,
        credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token" }],
        createdByUserId: userA,
      });

      // First finish: creates profile
      const result1 = await service.finishGalleryAppConnection(
        companyId,
        instance.id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [] } },
        userActor(userA),
      );
      expect(result1.connection.status).toBe("active");
      expect(result1.createdProfile).toBe(true);

      // Second finish: profile already exists
      const result2 = await service.finishGalleryAppConnection(
        companyId,
        instance.id,
        { enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: { agentIds: [] } },
        userActor(userA),
      );
      expect(result2.connection.status).toBe("active");
      expect(result2.createdProfile).toBe(false);
    });

    it("11. owner callback failure marks error and non-owner callback failure doesn't", async () => {
      const { companyId, userA, userB } = await seededCompanyWithMembers();
      const seed = (await googleSeed(companyId))!;
      const instance = await svc().ensurePersonalDefaultMcpInstance(companyId, seed.id, userA);

      // Configure mock OAuth endpoints on instance.config so endpoint discovery succeeds
      // without extra network calls and directs token exchange to a mock token endpoint.
      await db
        .update(toolConnections)
        .set({
          status: "draft",
          healthStatus: "ok",
          healthMessage: "Connected",
          lastError: null,
          config: {
            ...((instance.config as Record<string, unknown>) ?? {}),
            oauth: {
              authorizationUrl: "https://8.8.8.8/authorize",
              tokenUrl: "https://8.8.8.8/token",
              clientRegistrationSource: "manual",
              clientId: "test-client",
              clientTokenEndpointAuthMethod: "none",
            },
          },
        })
        .where(eq(toolConnections.id, instance.id));

      // Service with remoteHttpRequest returning 401 invalid_client on token exchange
      const failingService = toolAccessService(db, {
        remoteHttpRequest: async () =>
          new Response(JSON.stringify({ error: "invalid_client" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      });

      // Part A: Owner userA callback failure marks connection as error
      const ownerState = randomUUID();
      await db.insert(toolOauthStates).values({
        state: ownerState,
        companyId,
        connectionId: instance.id,
        codeVerifier: "verifier-owner",
        createdByActorType: "user",
        createdByActorId: userA,
        subjectUserId: userA,
        expiresAt: new Date(Date.now() + 600_000),
      });

      await expect(
        failingService.completeOAuthCallback({
          state: ownerState,
          code: "owner-auth-code",
          redirectUri: "https://paperclip.example.test/api/tools/oauth/callback",
          actor: userActor(userA),
        }),
      ).rejects.toMatchObject({ details: { code: "oauth_token_exchange_failed" } });

      const [rowAfterOwner] = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, instance.id));
      expect(rowAfterOwner!.healthStatus).toBe("error");
      expect(rowAfterOwner!.healthMessage).toBe("Sign-in failed. Reconnect this app to continue.");
      expect(rowAfterOwner!.lastError).toBe("oauth_token_exchange_failed");

      // Reset connection health back to ok
      await db
        .update(toolConnections)
        .set({ healthStatus: "ok", healthMessage: "Connected", lastError: null })
        .where(eq(toolConnections.id, instance.id));

      // Part B: Non-owner userB callback failure does NOT mark connection as error
      const nonOwnerState = randomUUID();
      await db.insert(toolOauthStates).values({
        state: nonOwnerState,
        companyId,
        connectionId: instance.id,
        codeVerifier: "verifier-non-owner",
        createdByActorType: "user",
        createdByActorId: userB,
        subjectUserId: userB,
        expiresAt: new Date(Date.now() + 600_000),
      });

      await expect(
        failingService.completeOAuthCallback({
          state: nonOwnerState,
          code: "non-owner-auth-code",
          redirectUri: "https://paperclip.example.test/api/tools/oauth/callback",
          actor: userActor(userB),
        }),
      ).rejects.toMatchObject({ details: { code: "oauth_token_exchange_failed" } });

      const [rowAfterNonOwner] = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, instance.id));
      expect(rowAfterNonOwner!.healthStatus).toBe("ok");
      expect(rowAfterNonOwner!.healthMessage).toBe("Connected");
      expect(rowAfterNonOwner!.lastError).toBeNull();
    });

    it("12. actual sweepConnectionHealth cross-company: A personal owner no grant => missing_secret, B owner active access-token grant not missing_secret", async () => {
      const companyA = await seededCompanyWithMembers();
      const companyB = await seededCompanyWithMembers();

      const seedA = (await googleSeed(companyA.companyId))!;
      const instanceA = await svc().ensurePersonalDefaultMcpInstance(companyA.companyId, seedA.id, companyA.userA);

      const seedB = (await googleSeed(companyB.companyId))!;
      const instanceB = await svc().ensurePersonalDefaultMcpInstance(companyB.companyId, seedB.id, companyB.userA);

      // Company A: instanceA owner (companyA.userA) has NO grant.
      // Set to active & enabled, healthStatus ok, past healthCheckedAt so it's due for sweep.
      await db
        .update(toolConnections)
        .set({
          status: "active",
          enabled: true,
          healthStatus: "ok",
          healthMessage: "Connected",
          healthCheckedAt: new Date(Date.now() - 3600_000),
        })
        .where(eq(toolConnections.id, instanceA.id));

      // Company B: instanceB owner (companyB.userA) HAS an active user grant with oauth.access_token.
      const { writeConnectionCredential } = await import("../services/connection-credentials.js");
      const { secret: secretB } = await writeConnectionCredential(db, {
        companyId: companyB.companyId,
        connectionName: instanceB.name,
        configPath: "oauth.access_token",
        label: "owner google token B",
        value: "owner-b-token-value",
        ownerUserId: companyB.userA,
        definitionKey: `test.google.${randomUUID()}`,
      });
      await db.insert(connectionGrants).values({
        companyId: companyB.companyId,
        connectionId: instanceB.id,
        kind: "user",
        subjectUserId: companyB.userA,
        status: "active",
        isDefault: false,
        credentialSecretRefs: [{ secretId: secretB.id, configPath: "oauth.access_token" }],
        createdByUserId: companyB.userA,
      });

      const { syncConnectionCredentialBindings } = await import("../services/connection-credential-bindings.js");
      await syncConnectionCredentialBindings(db, instanceB);

      await db
        .update(toolConnections)
        .set({
          status: "active",
          enabled: true,
          healthStatus: "ok",
          healthMessage: "Connected",
          healthCheckedAt: new Date(Date.now() - 3600_000),
        })
        .where(eq(toolConnections.id, instanceB.id));

      const remote = vi.fn(async (_url: string, init?: RequestInit) =>
        mcpRemoteResponse(init, { tools: [] }),
      );
      const sweepService = toolAccessService(db, {
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: remote,
      });

      // Run actual sweepConnectionHealth across both companies
      await sweepService.sweepConnectionHealth({ staleAfterMs: 0 });

      // Instance A in Company A has no owner grant => marked missing_secret
      const [rowA] = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, instanceA.id));
      expect(rowA!.healthStatus).toBe("missing_secret");
      expect(rowA!.healthMessage).toBe("This app has no connected account. Click Connect to sign in again.");

      // Instance B in Company B has active owner grant with access token => not missing_secret (remains ok)
      const [rowB] = await db
        .select()
        .from(toolConnections)
        .where(eq(toolConnections.id, instanceB.id));
      expect(rowB!.healthStatus).not.toBe("missing_secret");
      expect(rowB!.healthStatus).toBe("ok");
    });
  });
});
