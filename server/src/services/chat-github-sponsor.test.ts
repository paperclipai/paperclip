import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  activityLog, agents, chatEndpoints, chatGitHubConfigurations, companies,
  companyMemberships, createDb, instanceUserRoles, principalPermissionGrants, toolApplications, toolConnections,
} from "@paperclipai/db";
import {
  CHAT_PROVIDERS, createChatEndpointSchema, defaultGitHubReviewPolicy,
  updateChatEndpointSchema, type GitHubChatConfiguration,
} from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { githubChatManagementService } from "./chat-github-management.js";
import { chatChannelRoutes } from "../routes/chat-channels.js";
import type { ChatChannelService } from "./chat-channels.js";
import { errorHandler } from "../middleware/index.js";

describe("chat sponsor input boundaries", () => {
  it.each(CHAT_PROVIDERS.filter((provider) => provider !== "agentmail"))(
    "%s does not accept a caller-selected endpoint sponsor", (provider) => {
      expect(createChatEndpointSchema.safeParse({ provider, assignedAgentId: randomUUID(), sponsorUserId: "victim" }).success).toBe(false);
      expect(updateChatEndpointSchema.safeParse({ allowUnlinkedPeople: true, sponsorUserId: "victim" }).success).toBe(false);
    },
  );
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub sponsor assignment authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-sponsor-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function fixture(role = "operator") {
    const userId = randomUUID();
    const otherUserId = randomUUID();
    const [company] = await db.insert(companies).values({ name: "Sponsor test", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values([
      { companyId: company.id, principalType: "user", principalId: userId, status: "active", membershipRole: role },
      { companyId: company.id, principalType: "user", principalId: otherUserId, status: "active", membershipRole: "operator" },
    ]);
    await db.insert(principalPermissionGrants).values({ companyId: company.id, principalType: "user", principalId: userId, permissionKey: "tools:manage_connections" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Reviewer", role: "general", adapterType: "codex_local" }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "GitHub", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, name: "GitHub", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk" }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: company.id, provider: "github", publicId: randomUUID(), connectionId: connection.id, assignedAgentId: agent.id, sponsorUserId: userId }).returning();
    const management = githubChatManagementService(db);
    const configuration: GitHubChatConfiguration = {
      version: 1, toolsEnabled: false, responsibleUserId: userId,
      memberAccess: "all_linked", people: [], defaults: defaultGitHubReviewPolicy(), repositories: {},
    };
    const save = (config = configuration, expectedRevision = 0) => management.saveConfiguration(endpoint.id, { configuration: config, expectedRevision }, userId);
    return { company, endpoint, userId, otherUserId, configuration, save };
  }

  it.each(["responsible", "guest"])("rejects another person's %s sponsorship before any write", async (field) => {
    const f = await fixture();
    const config = structuredClone(f.configuration);
    if (field === "responsible") config.responsibleUserId = f.otherUserId;
    else config.people.push({ kind: "guest", githubUserId: "42", login: "guest", sponsorUserId: f.otherUserId, permissionProfile: "restricted" });
    await expect(f.save(config)).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id))).toEqual([]);
    expect((await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id)))[0].sponsorUserId).toBe(f.userId);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.endpoint.connectionId))).toEqual([]);
  });

  it("allows a connection manager to sponsor themselves and records that actor", async () => {
    const f = await fixture();
    f.configuration.people.push({ kind: "guest", githubUserId: "42", login: "guest", sponsorUserId: f.userId, permissionProfile: "restricted" });
    expect(await f.save()).toMatchObject({ revision: 1, configuration: f.configuration });
    expect((await db.select().from(activityLog).where(eq(activityLog.entityId, f.endpoint.connectionId)))[0]).toMatchObject({ actorId: f.userId, action: "chat_github.configuration_updated" });
  });

  it.each(["owner", "admin", "instance_admin"])("allows a current %s to select another active member", async (role) => {
    const f = await fixture(role === "instance_admin" ? "operator" : role);
    if (role === "instance_admin") await db.insert(instanceUserRoles).values({ userId: f.userId, role });
    f.configuration.responsibleUserId = f.otherUserId;
    f.configuration.people.push({ kind: "guest", githubUserId: "42", login: "guest", sponsorUserId: f.otherUserId, permissionProfile: "restricted" });
    expect(await f.save()).toMatchObject({ revision: 1, configuration: f.configuration });
    expect((await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpoint.id)))[0].sponsorUserId).toBe(f.otherUserId);
  });

  it.each(["viewer", "suspended", "foreign"])("rejects a %s sponsor even for an admin", async (fault) => {
    const f = await fixture("admin");
    if (fault === "foreign") f.configuration.responsibleUserId = randomUUID();
    else {
      f.configuration.responsibleUserId = f.otherUserId;
      await db.update(companyMemberships).set(fault === "viewer" ? { membershipRole: "viewer" } : { status: "suspended" }).where(eq(companyMemberships.principalId, f.otherUserId));
    }
    await expect(f.save()).rejects.toMatchObject({ status: 403 });
  });

  it.each(["admin", "instance_admin"])("rechecks revoked %s authority on the next save", async (role) => {
    const f = await fixture(role === "admin" ? "admin" : "operator");
    if (role === "instance_admin") await db.insert(instanceUserRoles).values({ userId: f.userId, role });
    f.configuration.responsibleUserId = f.otherUserId;
    await f.save();
    await db.update(companyMemberships).set({ membershipRole: "operator" }).where(eq(companyMemberships.principalId, f.userId));
    await db.delete(instanceUserRoles).where(eq(instanceUserRoles.userId, f.userId));
    await expect(f.save(f.configuration, 1)).rejects.toMatchObject({ status: 403 });
    expect((await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id)))[0].revision).toBe(1);
  });

  it("does not borrow an admin role from another company", async () => {
    const f = await fixture();
    const [other] = await db.insert(companies).values({ name: "Other company", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(companyMemberships).values({ companyId: other.id, principalType: "user", principalId: f.userId, status: "active", membershipRole: "admin" });
    f.configuration.responsibleUserId = f.otherUserId;
    await expect(f.save()).rejects.toMatchObject({ status: 403 });
  });

  it.each(["operator", "admin", "agent"])("enforces sponsor authority through the HTTP API for %s", async (role) => {
    const f = await fixture(role === "admin" ? "admin" : "operator");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = role === "agent"
        ? { type: "agent", companyId: f.company.id, agentId: f.endpoint.assignedAgentId }
        : { type: "board", source: "session", userId: f.userId, companyIds: [f.company.id] };
      next();
    });
    app.use("/api", chatChannelRoutes(db, {
      service: { get: async () => f.endpoint } as unknown as ChatChannelService,
      heartbeat: { wakeup: vi.fn() },
    }));
    app.use(errorHandler);
    const configuration = { ...f.configuration, responsibleUserId: f.otherUserId };
    await request(app).put(`/api/chat-endpoints/${f.endpoint.id}/github/configuration`)
      .send({ expectedRevision: 0, configuration }).expect(role === "admin" ? 200 : 403);
    const saved = await db.select().from(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, f.endpoint.id));
    expect(saved).toHaveLength(role === "admin" ? 1 : 0);
    if (role === "admin") expect(saved[0].updatedByUserId).toBe(f.userId);
  });
});
