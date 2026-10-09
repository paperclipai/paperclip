import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type Request, type ErrorRequestHandler } from "express";
import request from "supertest";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createDb, agents, companies, assets, activityLog, authUsers, companyMemberships, mcpOauthClients, mcpOauthGrants, dotAgentBindings, principalPermissionGrants } from "@paperclipai/db";
import { appearanceForPalette, MAX_AGENT_AVATAR_BYTES } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { normalizeAgentAvatar, setAgentProfileAvatar } from "../services/agent-profile-avatar.js";
import { agentProfileAvatarRoutes } from "../routes/agent-profile-avatar.js";
import { assetRoutes } from "../routes/assets.js";
import { agentService } from "../services/agents.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { createDotRunnerMcpTools } from "../services/dot-runner-broker.js";
import type { McpPrincipal } from "../services/public-mcp/oauth.js";
import { isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";

let storage: StorageService;
vi.mock("../storage/index.js", () => ({ getStorageService: () => storage }));
let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let root: string;
let imageBase64: string;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("paperclip-profile-avatar-");
  db = createDb(temporary.connectionString);
  root = await mkdtemp(join(tmpdir(), "profile-avatar-"));
  storage = createStorageService(createLocalDiskStorageProvider(root));
  imageBase64 = (await sharp({ create: { width: 800, height: 600, channels: 3, background: "orange" } }).png().toBuffer()).toString("base64");
  await instanceSettingsService(db).updateExperimental({ enablePublicMcp: true, enableOpenAiDot: true });
}, 120000);
afterAll(async () => { await temporary?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const [company] = await db.insert(companies).values({ name: "Avatar test", issuePrefix: randomUUID().slice(0, 8) }).returning();
  const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Dot", status: "active", adapterType: "paperclip_runner", appearance: appearanceForPalette("deep-tide") }).returning();
  const actor = { actorType: "agent" as const, actorId: agent!.id, agentId: agent!.id };
  return { company: company!, agent: agent!, actor };
}
function appFor(actor: Request["actor"]) {
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use((req, _res, next) => { req.actor = actor; next(); });
  app.use("/api", agentProfileAvatarRoutes(db, storage), assetRoutes(db, storage));
  app.use(((error, _req, res, _next) => res.status(error.status ?? 400).json({ error: error.message })) as ErrorRequestHandler);
  return app;
}

it("uploads, normalizes, serves privately, retries without duplication, and resets the avatar", async () => {
  const f = await fixture();
  const app = appFor({ type: "agent", agentId: f.agent.id, companyId: f.company.id });
  const path = `/api/companies/${f.company.id}/agents/${f.agent.id}/avatar`;
  const upload = await request(app).put(path).send({ imageBase64 }).expect(200);
  expect(upload.body.appearance.paletteId).toBe(f.agent.appearance?.paletteId);
  const retry = await request(app).put(path).send({ imageBase64 }).expect(200);
  expect(retry.body).toEqual(upload.body);
  expect(await db.select().from(assets).where(eq(assets.companyId, f.company.id))).toHaveLength(1);
  const audit = await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id));
  expect(audit.filter(row => row.action === "agent.avatar_updated")).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(imageBase64);
  const content = await request(app).get(upload.body.avatarUrl).expect(200);
  expect(content.headers["cache-control"]).toContain("private");
  expect(await sharp(content.body).metadata()).toMatchObject({ format: "png", width: 512, height: 384 });
  expect((await agentService(db).getById(f.agent.id))?.avatarUrl).toBe(upload.body.avatarUrl);
  const reset = await request(app).put(path).send({ imageBase64: null }).expect(200);
  expect(reset.body.appearance).toEqual(f.agent.appearance);
  expect(reset.body.avatarUrl).toContain("/api/agent-avatars/");
});

it("rejects other agents, companies, viewers, and foreign asset references", async () => {
  const f = await fixture(); const other = await fixture();
  const path = `/api/companies/${f.company.id}/agents/${f.agent.id}/avatar`;
  for (const actor of [
    { type: "agent", agentId: other.agent.id, companyId: f.company.id },
    { type: "agent", agentId: other.agent.id, companyId: other.company.id },
    { type: "board", source: "session", companyIds: [f.company.id], memberships: [{ companyId: f.company.id, status: "active", membershipRole: "viewer" }] },
  ] satisfies Request["actor"][]) await request(appFor(actor)).put(path).send({ imageBase64 }).expect(403);
  await request(appFor({ type: "none" })).put(path).send({ imageBase64 }).expect(401);
  const foreign = await setAgentProfileAvatar(db, storage, other.company.id, other.agent.id, { imageBase64 }, other.actor);
  await expect(agentService(db).update(f.agent.id, { appearance: foreign.appearance })).rejects.toThrow("avatar upload");
  await request(appFor({ type: "agent", agentId: f.agent.id, companyId: f.company.id })).get(foreign.avatarUrl).expect(404);
});

it("requires an agent configuration grant for board avatar changes", async () => {
  const f = await fixture();
  const userId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Member", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: userId, membershipRole: "member", status: "active" });
  const app = appFor({ type: "board", source: "session", userId, companyIds: [f.company.id], memberships: [{ companyId: f.company.id, status: "active", membershipRole: "member" }] });
  const path = `/api/companies/${f.company.id}/agents/${f.agent.id}/avatar`;
  await request(app).put(path).send({ imageBase64 }).expect(403);
  await request(app).put(path).send({ imageBase64: null }).expect(403);
  expect(await db.select().from(assets).where(eq(assets.companyId, f.company.id))).toHaveLength(0);
  await db.insert(principalPermissionGrants).values({ companyId: f.company.id, principalType: "user", principalId: userId, permissionKey: "agents:suggest-changes" });
  await request(app).put(path).send({ imageBase64 }).expect(403);
  await db.insert(principalPermissionGrants).values({ companyId: f.company.id, principalType: "user", principalId: userId, permissionKey: "agents:configure" });
  await request(app).put(path).send({ imageBase64 }).expect(200);
  await request(app).put(path).send({ imageBase64: null }).expect(200);
});

it.each([
  { kind: "task_bridge" as const, parentIssueId: randomUUID() },
  { kind: "skill_test" as const, issueId: randomUUID() },
])("rejects profile changes by restricted %s credentials", async keyScope => {
  const f = await fixture();
  const app = appFor({ type: "agent", agentId: f.agent.id, companyId: f.company.id, keyScope });
  const path = `/api/companies/${f.company.id}/agents/${f.agent.id}/avatar`;
  await request(app).put(path).send({ imageBase64 }).expect(403);
  await request(app).put(path).send({ imageBase64: null }).expect(403);
  expect(await db.select().from(assets).where(eq(assets.companyId, f.company.id))).toHaveLength(0);
  expect(await db.select().from(activityLog).where(eq(activityLog.companyId, f.company.id))).toHaveLength(0);
  expect((await agentService(db).getById(f.agent.id))?.appearance).toEqual(f.agent.appearance);
});

it("rejects URLs, SVG, corrupt and oversized images, unsupported fields and inactive agents", async () => {
  for (const input of ["https://example.test/avatar.png", Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>").toString("base64"), Buffer.from("broken").toString("base64"), Buffer.alloc(MAX_AGENT_AVATAR_BYTES + 1).toString("base64")]) {
    await expect(normalizeAgentAvatar(input)).rejects.toThrow();
  }
  const tooManyPixels = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "white" } }).png().toBuffer();
  await expect(normalizeAgentAvatar(tooManyPixels.toString("base64"))).rejects.toThrow("16 megapixels");
  const f = await fixture();
  const app = appFor({ type: "agent", agentId: f.agent.id, companyId: f.company.id });
  await request(app).put(`/api/companies/${f.company.id}/agents/${f.agent.id}/avatar`).send({ imageBase64, agentId: randomUUID() }).expect(400);
  await db.update(agents).set({ status: "pending_approval" }).where(eq(agents.id, f.agent.id));
  await expect(setAgentProfileAvatar(db, storage, f.company.id, f.agent.id, { imageBase64 }, f.actor)).rejects.toThrow("current state");
});

it("lets a paired Dot upload without an assignment, with feature and current grant authorization", async () => {
  const f = await fixture(); const userId = randomUUID(); const clientId = randomUUID();
  await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(companyMemberships).values({ companyId: f.company.id, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
  await db.insert(mcpOauthClients).values({ id: clientId, name: "Dot", redirectUris: [] });
  const [grant] = await db.insert(mcpOauthGrants).values({ companyId: f.company.id, userId, clientId, resource: "https://paperclip.example/mcp/runner", purpose: "agent", agentId: f.agent.id, scopes: ["paperclip:agent"] }).returning();
  await db.insert(dotAgentBindings).values({ companyId: f.company.id, agentId: f.agent.id, operatorId: userId, grantId: grant!.id, status: "connected" });
  const principal: McpPrincipal = { grant: grant!, company: f.company, actor: { type: "agent", companyId: f.company.id, agentId: f.agent.id } };
  const tools = createDotRunnerMcpTools(db);
  expect((await tools.listTools(principal)).find(tool => tool.name === "paperclip_dot_set_avatar")?.annotations).toMatchObject({ readOnlyHint: false });
  expect(await tools.callTool(principal, "paperclip_dot_set_avatar", { imageBase64 })).toMatchObject({ outcome: "completed", result: { agentId: f.agent.id } });
  await expect(tools.callTool(principal, "paperclip_dot_set_avatar", { imageBase64, agentId: randomUUID() })).rejects.toThrow();
  await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: false });
  try { await expect(tools.callTool(principal, "paperclip_dot_set_avatar", { imageBase64 })).rejects.toThrow("disabled"); }
  finally { await instanceSettingsService(db).updateExperimental({ enableOpenAiDot: true }); }
  await db.update(mcpOauthGrants).set({ revokedAt: new Date() }).where(eq(mcpOauthGrants.id, grant!.id));
  await expect(tools.callTool(principal, "paperclip_dot_set_avatar", { imageBase64 })).rejects.toThrow("authority");
});

it("redacts HTTP diagnostics containing image bytes", () => {
  expect(isSecretSensitiveHttpRequest("PUT", "/api/companies/company/agents/agent/avatar")).toBe(true);
  expect(isSecretSensitiveHttpRequest("POST", "/mcp/runner")).toBe(true);
});
