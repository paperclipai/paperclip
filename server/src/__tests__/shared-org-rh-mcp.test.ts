import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, companySecretBindings, companySecretVersions, companySecrets, connectionGrants, connectionTokenIssuances, createDb, heartbeatRuns, toolAccessAuditEvents, toolApplications, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolMcpGatewayTokens, toolMcpGateways, toolOauthStates, toolProfileBindings, toolProfileEntries, toolProfiles, toolRuntimeSlots, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { logger } from "../middleware/logger.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  RH_MCP_SERVICE_TOKEN_SCOPES,
  composeRhMcpServiceSub,
} from "../services/comms-board-provisioner-client.js";
import {
  DEFAULT_MCP_SPEC,
  RH_MCP_SERVICE_REVIEWED_TOOLS,
  RH_MCP_SERVICE_TOOLS_BY_SCOPE,
} from "../services/default-mcp-spec.js";
import { snapshotDefaultMcpForNewAgent } from "../services/default-mcp-setup.js";
import {
  SHARED_ORG_RH_MCP_CONNECTION_NAME,
  SHARED_ORG_RH_MCP_ENABLED_ENV,
  SHARED_ORG_RH_MCP_EXPIRY_CONFIG_KEY,
  SHARED_ORG_RH_MCP_REFRESH_WINDOW_MS,
  SHARED_ORG_RH_MCP_URL_ENV,
  ensureSharedOrgRhMcp,
  startSharedOrgRhMcpSweep,
  sweepSharedOrgRhMcp,
  type SharedOrgRhMcpContext,
} from "../services/shared-org-rh-mcp.js";
import { withoutCommsInstallByDefault } from "./helpers/comms-install-by-default.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const FEATURE_ENV = "PAPERCLIP_DEFAULT_MCP_SPEC_ENABLED";
const RH_MCP_URL = "https://8.8.8.8/mcp";
const OWNERSHIP_URL = "https://ownership.example.test";
const OWNERSHIP_TOKEN = "ownership-write-SECRET-token";
const MINTED_TOKEN = "rh-mcp-service-SECRET-token-0123456789";
const ROTATED_TOKEN = "rh-mcp-service-ROTATED-SECRET-token-9876543210";
/** Tools rh-mcp lists that the service token must NOT be offered to agents. */
const UNREVIEWED_TOOLS = ["supabase_query_data", "supabase_execute_sql", "mdm_write_annotation", "mdm_get_user_annotations", "zoom__get_transcript", "argus_get_proxy_token"];

const ENV: NodeJS.ProcessEnv = {
  [FEATURE_ENV]: "true",
  [SHARED_ORG_RH_MCP_ENABLED_ENV]: "true",
  [SHARED_ORG_RH_MCP_URL_ENV]: RH_MCP_URL,
  [COMMS_BOARD_MCP_URL_ENV]: "https://board.example.test/mcp",
  [COMMS_BOARD_ADMIN_TOKEN_ENV]: "board-admin-SECRET-token",
  [COMMS_BOARD_OWNERSHIP_API_URL_ENV]: OWNERSHIP_URL,
  [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: OWNERSHIP_TOKEN,
};

interface MintCall {
  url: string;
  sub: string;
  ownerEmail: string | null;
  scopes: string[];
  expires: number;
}

/** One fetch for both downstreams: the ownership API (mint + rotate) and rh-mcp itself (handshake + tools/list). */
function makeFetch(
  opts: {
    mint?: (call: MintCall) => Response | "throw" | null;
    rotate?: () => Response | "throw" | null;
    listFails?: boolean;
  } = {},
) {
  const calls = { mints: [] as MintCall[], rotates: [] as MintCall[], toolsList: 0, authorizations: [] as Array<string | null> };
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers as HeadersInit | undefined);
    if (url === `${OWNERSHIP_URL}/agents` || url.startsWith(`${OWNERSHIP_URL}/agents/`)) {
      const body = JSON.parse(init.body as string);
      const isRotate = url.endsWith("/rotate");
      const sub = isRotate ? decodeURIComponent(url.slice(`${OWNERSHIP_URL}/agents/`.length, -"/rotate".length)) : body.sub;
      const call: MintCall = { url, sub, ownerEmail: body.owner_email ?? null, scopes: body.scopes, expires: body.expires_in_days };
      (isRotate ? calls.rotates : calls.mints).push(call);
      const planned = isRotate ? opts.rotate?.() : opts.mint?.(call);
      if (planned === "throw") throw new Error("network down");
      if (planned) return planned;
      return new Response(
        JSON.stringify({
          sub,
          owner_email: body.owner_email ?? "owner@redesignhealth.com",
          active: true,
          token: isRotate ? ROTATED_TOKEN : MINTED_TOKEN,
          token_expires_at: "2027-10-30T00:00:00+00:00",
        }),
        { status: isRotate ? 200 : 201, headers: { "content-type": "application/json" } },
      );
    }
    if (url === RH_MCP_URL) {
      if (init.method === "DELETE") return new Response(null, { status: 200 });
      calls.authorizations.push(headers.get("authorization"));
      const body = JSON.parse(init.body as string);
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "rh-mcp", version: "1" } } }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-rh-mcp-test" } },
        );
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list") {
        calls.toolsList += 1;
        if (opts.listFails) return new Response("down", { status: 503 });
        const tools = [...RH_MCP_SERVICE_REVIEWED_TOOLS, ...UNREVIEWED_TOOLS].map((name) => ({
          name,
          description: `${name} description`,
          inputSchema: { type: "object", properties: {} },
        }));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    throw new Error(`unexpected request ${url}`);
  });
  return Object.assign(fn, { calls });
}

describe("rh-mcp service tool set", () => {
  it("scopes are exactly the keys of the tool map, and never a write, secrets, impersonation or supabase scope", () => {
    expect([...RH_MCP_SERVICE_TOKEN_SCOPES].sort()).toEqual(Object.keys(RH_MCP_SERVICE_TOOLS_BY_SCOPE).sort());
    for (const scope of RH_MCP_SERVICE_TOKEN_SCOPES) {
      expect(scope).not.toMatch(/:(write|secrets|impersonate)$/);
      // `comps:run` is the one reviewed `:run` scope (TECH-8433): it only starts/polls/cancels an api-main comps job.
      if (scope.endsWith(":run")) expect(scope).toBe("comps:run");
      expect(scope.startsWith("supabase:")).toBe(false);
      expect(scope.startsWith("ownership:")).toBe(false);
      expect(scope.startsWith("comms:")).toBe(false);
    }
  });

  it("offers each tool once and never a supabase, write, impersonation, token-minting or identity-keyed tool", () => {
    expect(new Set(RH_MCP_SERVICE_REVIEWED_TOOLS).size).toBe(RH_MCP_SERVICE_REVIEWED_TOOLS.length);
    for (const tool of RH_MCP_SERVICE_REVIEWED_TOOLS) {
      expect(tool).not.toMatch(/^supabase_/);
      expect(tool).not.toMatch(/(write|create|delete|update|manage|start_research|start_analysis)/);
      expect(tool).not.toBe("argus_get_proxy_token");
    }
    for (const identityKeyed of ["mdm_get_user_annotations", "mdm_granola_status", "voice_get_style_guide", "voice_list_voices", "voice_list_source_docs"]) {
      expect(RH_MCP_SERVICE_REVIEWED_TOOLS).not.toContain(identityKeyed);
    }
    expect(RH_MCP_SERVICE_TOOLS_BY_SCOPE["comps:run"]).toEqual(["comps__start", "comps__get", "comps__cancel"]);
    // voice_apply rides the existing voice:read scope: no new scope, so no org-token rotation.
    expect(RH_MCP_SERVICE_TOOLS_BY_SCOPE["voice:read"]).toContain("voice_apply");
    // The blocking one-call comps tool outlives the gateway's 60 s clamp, so only the async verbs are offered.
    expect(RH_MCP_SERVICE_REVIEWED_TOOLS).not.toContain("comps__run_business_area_comps");
    // The review verbs are what ClaudeBot-style agents need; losing them would silently recreate TECH-8066.
    expect(RH_MCP_SERVICE_REVIEWED_TOOLS).toEqual(expect.arrayContaining(["argus_start_review", "argus_get_review", "argus_cancel_review"]));
  });

  it("registers an ON-by-default ordinary spec entry whose ceiling is the reviewed set", () => {
    const entry = DEFAULT_MCP_SPEC.find((candidate) => candidate.key === "rh-mcp-service");
    expect(entry).toBeDefined();
    expect(entry!.connectionName).toBe(SHARED_ORG_RH_MCP_CONNECTION_NAME);
    expect(entry!.defaultEnabled).toBe(true);
    expect(entry!.setupHook).toBeUndefined();
    expect(entry!.reviewedTools?.allow).toEqual(RH_MCP_SERVICE_REVIEWED_TOOLS);
  });

  it("composes one canonical sub per org and refuses anything that is not a UUID", () => {
    const id = "0B2C7C1E-4F0A-4A4E-9B3E-0D6F0A3C9A11";
    expect(composeRhMcpServiceSub(id)).toBe(`paperclip-rh-mcp-${id.toLowerCase()}`);
    expect(composeRhMcpServiceSub("not-a-uuid")).toBeNull();
    expect(composeRhMcpServiceSub(`${id}::x`)).toBeNull();
  });
});

describeEmbeddedPostgres("shared-org rh-mcp service connection (TECH-8066)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-shared-org-rh-mcp-${randomUUID()}`);
  let restoreCommsInstallDefault: (() => void) | null = null;

  beforeAll(async () => {
    restoreCommsInstallDefault = withoutCommsInstallByDefault();
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("shared-org-rh-mcp");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    restoreCommsInstallDefault?.();
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  // ---- harness ------------------------------------------------------------------------------

  function ctxFor(fetchMock: ReturnType<typeof makeFetch>, overrides: Partial<SharedOrgRhMcpContext> = {}): SharedOrgRhMcpContext {
    return {
      db,
      env: { ...ENV },
      fetchImpl: fetchMock,
      templateScope: { mode: "all" },
      toolAccessOptions: {
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: async (url, init) => fetchMock(url, init),
      },
      ...overrides,
    };
  }

  async function seedCompany(opts: { visibility?: "shared" | "private" | null; status?: "active" | "paused" | "archived" } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company-${companyId.slice(0, 8)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      status: opts.status ?? "active",
      visibility: opts.visibility === undefined ? "shared" : opts.visibility,
    });
    return companyId;
  }

  async function seedOwner(companyId: string, email = `owner-${randomUUID().slice(0, 8)}@redesignhealth.com`) {
    const userId = `user-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, name: "Owner", email, emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner", createdAt: now });
    return { userId, email };
  }

  async function seedAgent(companyId: string, status = "idle") {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name: `agent-${id.slice(0, 6)}`, role: "general", status, adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {}, metadata: {} });
    return id;
  }

  const connectionsOf = (companyId: string) =>
    db.select().from(toolConnections).where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.name, SHARED_ORG_RH_MCP_CONNECTION_NAME)));

  async function enabledToolNames(connectionId: string, companyId: string): Promise<string[]> {
    const rows = await db
      .select({ toolName: toolCatalogEntries.toolName })
      .from(toolProfileEntries)
      .innerJoin(toolCatalogEntries, eq(toolCatalogEntries.id, toolProfileEntries.catalogEntryId))
      .where(and(eq(toolProfileEntries.companyId, companyId), eq(toolProfileEntries.connectionId, connectionId)));
    return rows.map((row) => row.toolName).sort();
  }

  const installsOf = (connectionId: string) =>
    db.select({ targetId: toolConnectionInstalls.targetId, targetType: toolConnectionInstalls.targetType }).from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId));

  // ---- gating -------------------------------------------------------------------------------

  it("does nothing while the flag is off, and for a company outside the rollout scope", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch();
    const off = await ensureSharedOrgRhMcp(ctxFor(fetchMock, { env: { ...ENV, [SHARED_ORG_RH_MCP_ENABLED_ENV]: "false" } }), companyId);
    expect(off).toEqual({ kind: "skipped", reason: "disabled" });
    const specOff = await ensureSharedOrgRhMcp(ctxFor(fetchMock, { env: { ...ENV, [FEATURE_ENV]: "false" } }), companyId);
    expect(specOff).toEqual({ kind: "skipped", reason: "disabled" });
    const scoped = await ensureSharedOrgRhMcp(ctxFor(fetchMock, { templateScope: { mode: "allowlist", companyIds: [randomUUID()] } }), companyId);
    expect(scoped).toEqual({ kind: "skipped", reason: "out_of_scope" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await connectionsOf(companyId)).toHaveLength(0);
  });

  it("only provisions a company that is explicitly shared and live", async () => {
    const fetchMock = makeFetch();
    for (const [visibility, status, reason] of [
      ["private", "active", "not_shared"],
      [null, "active", "not_shared"],
      ["shared", "archived", "company_inactive"],
    ] as const) {
      const companyId = await seedCompany({ visibility, status });
      await seedOwner(companyId);
      expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId)).toEqual({ kind: "skipped", reason });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits, without calling anything, when the endpoint or the ownership credentials are not configured, or there is no owner", async () => {
    const companyId = await seedCompany();
    const fetchMock = makeFetch();
    const { [SHARED_ORG_RH_MCP_URL_ENV]: _url, ...withoutUrl } = ENV;
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock, { env: withoutUrl }), companyId)).toEqual({ kind: "waiting", reason: "not_configured" });
    const { [COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV]: _token, ...withoutOwnershipToken } = ENV;
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock, { env: withoutOwnershipToken }), companyId)).toEqual({ kind: "waiting", reason: "not_configured" });
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock, { env: { ...ENV, [SHARED_ORG_RH_MCP_URL_ENV]: "http://rh-mcp.example.test/mcp" } }), companyId)).toEqual({ kind: "waiting", reason: "not_configured" });
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId)).toEqual({ kind: "waiting", reason: "owner_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ---- provisioning -------------------------------------------------------------------------

  it("mints one scoped token for the org, connects, enables exactly the reviewed tools and installs every live agent", async () => {
    const companyId = await seedCompany();
    const owner = await seedOwner(companyId);
    const live = [await seedAgent(companyId), await seedAgent(companyId, "running")];
    const dead = await seedAgent(companyId, "terminated");
    const fetchMock = makeFetch();
    const logged: string[] = [];
    for (const level of ["info", "warn", "error", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);
    }

    const outcome = await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);

    expect(outcome).toEqual({ kind: "provisioned", installed: 2 });
    expect(fetchMock.calls.mints).toHaveLength(1);
    const mint = fetchMock.calls.mints[0]!;
    expect(mint.sub).toBe(composeRhMcpServiceSub(companyId));
    expect(mint.ownerEmail).toBe(owner.email.toLowerCase());
    expect([...mint.scopes].sort()).toEqual([...RH_MCP_SERVICE_TOKEN_SCOPES].sort());
    expect(mint.scopes).not.toContain("supabase:read");
    // The connection itself authenticates to rh-mcp with the minted token, as a Bearer.
    expect(fetchMock.calls.authorizations.every((value) => value === `Bearer ${MINTED_TOKEN}`)).toBe(true);

    const [connection] = await connectionsOf(companyId);
    expect(connection).toMatchObject({ status: "active", enabled: true, authKind: "api_key", credentialPolicy: "shared" });
    expect(new Date((connection!.config as Record<string, string>)[SHARED_ORG_RH_MCP_EXPIRY_CONFIG_KEY]!).toISOString()).toBe("2027-10-30T00:00:00.000Z");

    // Only the reviewed tools are enabled; supabase, writes and identity-keyed tools are discovered but off.
    const enabled = await enabledToolNames(connection!.id, companyId);
    expect(enabled).toEqual([...RH_MCP_SERVICE_REVIEWED_TOOLS].sort());
    for (const tool of UNREVIEWED_TOOLS) expect(enabled).not.toContain(tool);

    const installs = await installsOf(connection!.id);
    expect(installs.filter((row) => row.targetType === "agent").map((row) => row.targetId).sort()).toEqual([...live].sort());
    expect(installs.map((row) => row.targetId)).not.toContain(dead);

    // The token is only ever in the vault: not in logs, activity details or a plain config column.
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(activity?.action).toBe("company.shared_org_rh_mcp.provisioned");
    const everywhere = JSON.stringify([activity?.details, connection!.config, connection!.transportConfig, logged]);
    expect(everywhere).not.toContain(MINTED_TOKEN);
    const secretId = connection!.credentialSecretRefs[0]!.secretId;
    expect(await secretService(db).resolveSecretValue(companyId, secretId, "latest")).toBe(MINTED_TOKEN);
  });

  it("shared-org allowlist leaves denied settled: quarantined unreviewed tools become reviewed_declined", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    await seedAgent(companyId);
    const fetchMock = makeFetch();

    // Provision the shared connection
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    const [connection] = await connectionsOf(companyId);

    // Now simulate an unreviewed tool and an allowlisted tool being quarantined (e.g. schema drift or new discovery)
    const allowlistedTool = RH_MCP_SERVICE_REVIEWED_TOOLS[0]!;
    const unreviewedTool = UNREVIEWED_TOOLS[0]!;
    await db
      .update(toolCatalogEntries)
      .set({ status: "quarantined", quarantineReason: "pending_review" })
      .where(
        and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connection!.id),
          inArray(toolCatalogEntries.toolName, [allowlistedTool, unreviewedTool]),
        ),
      );

    // Call finishConnection (by resetting enabled to false to trigger finish on next tick)
    await db.update(toolConnections).set({ enabled: false }).where(eq(toolConnections.id, connection!.id));
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);

    const entries = await db
      .select()
      .from(toolCatalogEntries)
      .where(
        and(
          eq(toolCatalogEntries.companyId, companyId),
          eq(toolCatalogEntries.connectionId, connection!.id),
          inArray(toolCatalogEntries.toolName, [allowlistedTool, unreviewedTool]),
        ),
      );
    const byName = new Map(entries.map((r) => [r.toolName, r]));

    // Allowlisted tool was re-activated
    expect(byName.get(allowlistedTool)?.status).toBe("active");
    expect(byName.get(allowlistedTool)?.quarantineReason).toBeNull();

    // Denied (unreviewed) tool was left quarantined with reviewed_declined (settled)
    const denied = byName.get(unreviewedTool);
    expect(denied?.status).toBe("quarantined");
    expect(denied?.quarantineReason).toBe("reviewed_declined");
    expect(denied?.reviewedAt).toBeInstanceOf(Date);
    expect(denied?.reviewedByAgentId).toBeNull();
    expect(denied?.reviewedByUserId).toBeNull();

    // Settled decision means no attention needed for this connection
    const attention = await toolAccessService(db).listAppsNeedingAttention(companyId);
    expect(attention.apps.filter((app) => app.connection.id === connection!.id)).toHaveLength(0);
  });

  it("is idempotent: a second tick mints nothing and adds nothing", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    await seedAgent(companyId);
    const fetchMock = makeFetch();
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    const second = await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    expect(second).toEqual({ kind: "ready", installed: 0 });
    expect(fetchMock.calls.mints).toHaveLength(1);
    expect(await connectionsOf(companyId)).toHaveLength(1);
  });

  it("installs an agent created after the connection exists, on the next tick", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch();
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    const late = await seedAgent(companyId);
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId)).toEqual({ kind: "ready", installed: 1 });
    const [connection] = await connectionsOf(companyId);
    expect((await installsOf(connection!.id)).map((row) => row.targetId)).toContain(late);
  });

  it("turns the connection ON for a brand-new agent through the spec entry, and OFF in a company without it", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch();
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    const [connection] = await connectionsOf(companyId);
    const newAgent = await seedAgent(companyId);
    const state = await snapshotDefaultMcpForNewAgent(db, { companyId, agentId: newAgent });
    expect(state.entries["rh-mcp-service"]).toMatchObject({ dedicated: false, enabled: true, templateConnectionId: connection!.id });

    const otherCompany = await seedCompany({ visibility: "private" });
    const otherAgent = await seedAgent(otherCompany);
    const otherState = await snapshotDefaultMcpForNewAgent(db, { companyId: otherCompany, agentId: otherAgent });
    expect(otherState.entries["rh-mcp-service"]).toMatchObject({ enabled: false, templateConnectionId: null });
  });

  // ---- failure and recovery -----------------------------------------------------------------

  it("re-issues through rotate when the registry already holds the sub (a crashed earlier attempt)", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch({ mint: () => new Response("{}", { status: 409 }) });
    const outcome = await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    expect(outcome.kind).toBe("provisioned");
    expect(fetchMock.calls.rotates).toHaveLength(1);
    expect(fetchMock.calls.rotates[0]!.sub).toBe(composeRhMcpServiceSub(companyId));
    expect([...fetchMock.calls.rotates[0]!.scopes].sort()).toEqual([...RH_MCP_SERVICE_TOKEN_SCOPES].sort());
    const [connection] = await connectionsOf(companyId);
    expect(await secretService(db).resolveSecretValue(companyId, connection!.credentialSecretRefs[0]!.secretId, "latest")).toBe(ROTATED_TOKEN);
  });

  it("reports a closed reason, and leaves no connection, when the mint is refused or the network is down", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    expect(await ensureSharedOrgRhMcp(ctxFor(makeFetch({ mint: () => new Response("{}", { status: 403 }) })), companyId)).toEqual({ kind: "error", reason: "mint_failed" });
    expect(await ensureSharedOrgRhMcp(ctxFor(makeFetch({ mint: () => "throw" })), companyId)).toEqual({ kind: "error", reason: "mint_failed" });
    expect(await connectionsOf(companyId)).toHaveLength(0);
  });

  it("recovers on the next tick when discovery fails after the mint", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const broken = makeFetch({ listFails: true });
    const first = await ensureSharedOrgRhMcp(ctxFor(broken), companyId);
    expect(first).toEqual({ kind: "error", reason: "connect_failed" });
    expect((await connectionsOf(companyId)).filter((row) => row.status === "active")).toHaveLength(0);

    // The registry now holds the sub, so the retry rotates, and the setup completes.
    const healthy = makeFetch({ mint: () => new Response("{}", { status: 409 }) });
    const second = await ensureSharedOrgRhMcp(ctxFor(healthy), companyId);
    expect(second.kind).toBe("provisioned");
    const live = (await connectionsOf(companyId)).filter((row) => row.status !== "archived");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: "active", enabled: true });
  });

  it("treats an archived rh-mcp-service connection as the org's opt-out", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch();
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    await db.update(toolConnections).set({ status: "archived" }).where(eq(toolConnections.companyId, companyId));
    const outcome = await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    expect(outcome).toEqual({ kind: "skipped", reason: "opted_out" });
    expect(fetchMock.calls.mints).toHaveLength(1);
    expect(await connectionsOf(companyId)).toHaveLength(1);
  });

  it("refuses to guess when two live connections carry the name", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch();
    await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId);
    const [first] = await connectionsOf(companyId);
    await db.insert(toolConnections).values({ ...first!, id: randomUUID(), uid: `${first!.uid}-dup` });
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock), companyId)).toEqual({ kind: "error", reason: "ambiguous_connection" });
  });

  // ---- expiry -------------------------------------------------------------------------------

  it("re-issues the token into a new vault version before it expires", async () => {
    const companyId = await seedCompany();
    await seedOwner(companyId);
    const fetchMock = makeFetch();
    const now = new Date("2026-10-30T00:00:00Z");
    await ensureSharedOrgRhMcp(ctxFor(fetchMock, { now: () => now }), companyId);
    const [connection] = await connectionsOf(companyId);
    const secretId = connection!.credentialSecretRefs[0]!.secretId;

    // Far from expiry (2027-10-30): nothing happens.
    expect(await ensureSharedOrgRhMcp(ctxFor(fetchMock, { now: () => now }), companyId)).toEqual({ kind: "ready", installed: 0 });
    expect(fetchMock.calls.rotates).toHaveLength(0);

    // Inside the refresh window: rotate, store as a new version, record the new expiry.
    const nearExpiry = new Date(new Date("2027-10-30T00:00:00Z").getTime() - SHARED_ORG_RH_MCP_REFRESH_WINDOW_MS + 60_000);
    const outcome = await ensureSharedOrgRhMcp(ctxFor(fetchMock, { now: () => nearExpiry }), companyId);
    expect(outcome).toEqual({ kind: "rotated", installed: 0 });
    expect(fetchMock.calls.rotates).toHaveLength(1);
    expect(await secretService(db).resolveSecretValue(companyId, secretId, "latest")).toBe(ROTATED_TOKEN);
    const [secret] = await db.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets).where(eq(companySecrets.id, secretId));
    expect(secret!.latestVersion).toBe(2);
  });

  // ---- sweep --------------------------------------------------------------------------------

  it("sweeps every shared company, and only those", async () => {
    const sharedA = await seedCompany();
    const sharedB = await seedCompany();
    const priv = await seedCompany({ visibility: "private" });
    for (const id of [sharedA, sharedB, priv]) await seedOwner(id);
    const fetchMock = makeFetch();
    expect(await sweepSharedOrgRhMcp(ctxFor(fetchMock))).toBe(2);
    expect(await connectionsOf(sharedA)).toHaveLength(1);
    expect(await connectionsOf(sharedB)).toHaveLength(1);
    expect(await connectionsOf(priv)).toHaveLength(0);
  });

  it("visits every shared company across pages, not just the first page", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = await seedCompany();
      await seedOwner(id);
      ids.push(id);
    }
    const fetchMock = makeFetch();
    expect(await sweepSharedOrgRhMcp({ ...ctxFor(fetchMock), pageSize: 2 })).toBe(5);
    for (const id of ids) expect(await connectionsOf(id)).toHaveLength(1);
  });

  it("keeps sweeping after one company fails", async () => {
    const broken = await seedCompany();
    const fine = await seedCompany();
    await seedOwner(broken);
    await seedOwner(fine);
    const fetchMock = makeFetch({ mint: (call) => (call.sub === composeRhMcpServiceSub(broken) ? new Response("{}", { status: 403 }) : null) });
    await sweepSharedOrgRhMcp(ctxFor(fetchMock));
    expect(await connectionsOf(broken)).toHaveLength(0);
    expect(await connectionsOf(fine)).toHaveLength(1);
  });

  it("the periodic sweep is a no-op when the flag is off", () => {
    const stop = startSharedOrgRhMcpSweep(db, { env: { ...ENV, [SHARED_ORG_RH_MCP_ENABLED_ENV]: "false" } });
    expect(typeof stop).toBe("function");
    stop();
  });
});
