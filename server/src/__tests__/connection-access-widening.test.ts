import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companyMemberships, createDb, toolCatalogEntries, toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfiles } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { githubCredentialsFixture } from "./helpers/github-credentials-fixture.js";
import { toolAccessService } from "../services/tool-access.js";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";

const vault = vi.hoisted(() => ({
  resolveUserSecretValue: vi.fn(async () => ({ value: "test-token" })),
  resolveSecretValue: vi.fn(async () => "test-token"),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

const support = await getEmbeddedPostgresTestSupport();

/**
 * N-04: GitHub connected from a task chat is installed for the requesting
 * agent only. Widening "Which agents can use this connection?" to "Any agent"
 * on the Connectors page must reach other agents' runs, including agents hired
 * later, rather than only rewriting the access profile.
 */
(support.supported ? describe : describe.skip)("widening a live connection's agent access", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-connection-widening-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  }, 60_000);
  const { seed, grant } = githubCredentialsFixture(() => db);
  const board = { actorType: "user" as const, actorId: "A" };

  async function hire(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, role: "engineer", adapterType: "claude_local" });
    return id;
  }

  /** Task-chat connect: per-user grant, installed and permitted for the requesting agent only. */
  async function connectFromTaskChat() {
    const input = await seed();
    const selected = await grant(input, "A");
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, selected.connectionId));
    const [tool] = await db.insert(toolCatalogEntries).values({
      companyId: input.companyId, applicationId: connection.applicationId, connectionId: selected.connectionId,
      name: "get_me", toolName: "get_me", versionHash: "fixture", riskLevel: "read", isReadOnly: true,
    }).returning();
    const service = toolAccessService(db);
    const finish = (access: "all_agents" | { agentIds: string[] }, authorizeAgentInstall?: (agentId: string) => Promise<void>) =>
      service.finishGalleryAppConnection(input.companyId, selected.connectionId, {
        enabledCatalogEntryIds: [tool.id], askFirstCatalogEntryIds: [], access,
      }, board, { authorizeAgentInstall });
    await finish({ agentIds: [input.agentId] });
    return { input, selected, service, finish, tool };
  }

  async function installKeys(connectionId: string) {
    return (await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connectionId)))
      .map(install => `${install.targetType}:${install.targetId}`).sort();
  }

  async function githubFor(companyId: string, agentId: string) {
    return resolveManagedGitHubIdentitySelection(db, companyId, { agentId, responsibleUserId: "A" });
  }

  it("gives existing and later-hired agents GitHub after access is widened to any agent", async () => {
    const { input, selected, service, finish } = await connectFromTaskChat();
    const frontend = await hire(input.companyId, "Frontend Engineer");
    expect(await githubFor(input.companyId, frontend)).toEqual({ configured: false });

    // Connectors page → Permissions → "Any agent".
    await finish("all_agents");

    expect(await githubFor(input.companyId, frontend)).toMatchObject({ configured: true, grant: { id: selected.id } });
    const assignments = await service.getConnectionAssignmentsForAgent(input.companyId, frontend, [selected.connectionId]);
    expect(assignments.installedConnections.map(connection => connection.id)).toContain(selected.connectionId);
    expect(assignments.allowedConnectionIds).toContain(selected.connectionId);

    const designer = await hire(input.companyId, "Brand & Design");
    expect(await githubFor(input.companyId, designer)).toMatchObject({ configured: true, grant: { id: selected.id } });
  });

  it("installs an agent newly picked on the Permissions tab without touching other installs", async () => {
    const { input, selected, finish } = await connectFromTaskChat();
    const frontend = await hire(input.companyId, "Frontend Engineer");
    const designer = await hire(input.companyId, "Brand & Design");

    await finish({ agentIds: [input.agentId, frontend] });

    expect(await githubFor(input.companyId, frontend)).toMatchObject({ configured: true, grant: { id: selected.id } });
    expect(await githubFor(input.companyId, designer)).toEqual({ configured: false });
    const installs = await db.select().from(toolConnectionInstalls).where(and(
      eq(toolConnectionInstalls.companyId, input.companyId), eq(toolConnectionInstalls.connectionId, selected.connectionId),
    ));
    expect(installs.map(install => `${install.targetType}:${install.targetId}`).sort())
      .toEqual([`agent:${frontend}`, `agent:${input.agentId}`].sort());
  });

  it("does not install anything when a save restates the same access", async () => {
    const { input, selected, finish } = await connectFromTaskChat();
    const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, selected.connectionId));
    await finish({ agentIds: [input.agentId] });
    const after = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, selected.connectionId));
    expect(after.map(install => install.id)).toEqual(before.map(install => install.id));
  });

  it("keeps agents uninstalled when access narrows from any agent to picked agents", async () => {
    const { input, selected, service, finish } = await connectFromTaskChat();
    const frontend = await hire(input.companyId, "Frontend Engineer");
    await finish("all_agents");
    // The operator removes the company install but keeps company-wide access.
    await service.putConnectionInstalls(selected.connectionId, { installs: [{ targetType: "agent", targetId: input.agentId }] }, board);
    await finish({ agentIds: [input.agentId, frontend] });
    expect(await installKeys(selected.connectionId)).toEqual([`agent:${input.agentId}`]);
  });

  it("rejects and rolls back an agent install the caller may not make", async () => {
    const { input, selected, finish } = await connectFromTaskChat();
    const frontend = await hire(input.companyId, "Frontend Engineer");
    const authorizeAgentInstall = vi.fn(async (agentId: string) => { throw new Error(`denied ${agentId}`); });
    await expect(finish({ agentIds: [input.agentId, frontend] }, authorizeAgentInstall)).rejects.toThrow(`denied ${frontend}`);
    expect(authorizeAgentInstall).toHaveBeenCalledTimes(1);
    expect(await installKeys(selected.connectionId)).toEqual([`agent:${input.agentId}`]);
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.profileKey, `app:${selected.connectionId}`));
    const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile.id));
    expect(bindings.map(binding => binding.targetId)).toEqual([input.agentId]);
  });

  it("refuses a connection creator who cannot configure the newly picked agent", async () => {
    const { input, selected, tool } = await connectFromTaskChat();
    const frontend = await hire(input.companyId, "Frontend Engineer");
    await db.update(toolConnections).set({ createdByUserId: "creator" }).where(eq(toolConnections.id, selected.connectionId));
    await db.insert(companyMemberships).values({ companyId: input.companyId, principalType: "user", principalId: "creator", status: "active", membershipRole: "operator" });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "creator", userName: "Creator", userEmail: null, isInstanceAdmin: false, source: "session",
        companyIds: [input.companyId], memberships: [{ companyId: input.companyId, membershipRole: "operator", status: "active" }] };
      next();
    });
    app.use("/api", toolAccessRoutes(db));
    app.use(errorHandler);
    const response = await request(app).post(`/api/companies/${input.companyId}/tools/apps/${selected.connectionId}/finish`)
      .send({ enabledCatalogEntryIds: [tool.id], askFirstCatalogEntryIds: [], access: { agentIds: [input.agentId, frontend] } });
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toContain("so you cannot install this connection on it");
    expect(await installKeys(selected.connectionId)).toEqual([`agent:${input.agentId}`]);
    expect(await githubFor(input.companyId, frontend)).toEqual({ configured: false });
  });
});
