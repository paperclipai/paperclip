import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, companyMemberships, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;

describeEmbeddedPostgres("company AI health route", () => {
  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-health-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-health-routes");
    database = await startEmbeddedPostgresTestDatabase("paperclip-ai-health-db-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const userId = `owner-${companyId}`;
    await db.insert(companies).values([
      { id: companyId, name: "AI health", issuePrefix: `H${companyId.slice(0, 7)}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 7)}` },
    ]);
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active" });
    const accounts = aiConnectionService(db);
    const connect = (provider: "anthropic" | "openai", name: string, apiKey: string) =>
      accounts.save(companyId, userId, { provider, method: "api_key", name, ownership: "shared", apiKey, agentIds: [], allAgents: true }, apiKey);
    const claude = await connect("anthropic", "Claude for all", "fixture-claude-secret");
    const openai = await connect("openai", "OpenAI", "fixture-openai-secret");
    const revokedOpenai = await connect("openai", "Old OpenAI", "fixture-revoked-secret");
    const sharedBinding = (provider: "anthropic" | "openai", account: { connectionId: string; grantId: string }) =>
      ({ provider, method: "api_key", mode: "shared", ...account }) as const;
    const [forge, nureview, healthy, revokedUser, terminated, perRun] = Array.from({ length: 6 }, () => randomUUID());
    await db.insert(agents).values([
      { id: forge, companyId, name: "Forge", adapterType: "claude_local", adapterConfig: { env: { ANTHROPIC_API_KEY: "fixture-env-secret" } }, runtimeConfig: { aiConnection: sharedBinding("anthropic", claude) } },
      { id: nureview, companyId, name: "NuReview", adapterType: "claude_local", runtimeConfig: { aiConnection: sharedBinding("anthropic", claude) } },
      { id: healthy, companyId, name: "PR Nudge", adapterType: "codex_local", runtimeConfig: { aiConnection: sharedBinding("openai", openai) } },
      { id: revokedUser, companyId, name: "Archivist", adapterType: "codex_local", runtimeConfig: { aiConnection: sharedBinding("openai", revokedOpenai) } },
      { id: terminated, companyId, name: "Retired", adapterType: "claude_local", status: "terminated", runtimeConfig: { aiConnection: sharedBinding("anthropic", claude) } },
      { id: perRun, companyId, name: "Scout", adapterType: "claude_local", runtimeConfig: { aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } } },
    ]);
    await db.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign in again to restore this AI connection." }).where(eq(toolConnections.id, claude.connectionId));
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, revokedOpenai.grantId));
    return { companyId, otherCompanyId, userId, claude, revokedOpenai, forge, nureview, revokedUser };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", aiConnectionRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("lists broken connections that agents use, with the affected agents and no secrets", async () => {
    const f = await fixture();
    const app = appFor({ type: "board", source: "session", userId: f.userId, companyIds: [f.companyId], memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] });
    const response = await request(app).get(`/api/companies/${f.companyId}/ai-health`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      connections: [
        { id: f.revokedOpenai.connectionId, name: "Old OpenAI", provider: "openai", status: "revoked", affectedAgentIds: [f.revokedUser] },
        { id: f.claude.connectionId, name: "Claude for all", provider: "anthropic", status: "needs_attention", affectedAgentIds: [f.forge, f.nureview] },
      ],
    });
    expect(response.text).not.toMatch(/fixture-|grantId|env/);
    expect(response.text).not.toContain(f.claude.grantId);
  });

  it("rejects agents and boards without access to the company", async () => {
    const f = await fixture();
    const agentApp = appFor({ type: "agent", agentId: f.forge, companyId: f.companyId, companyIds: [f.companyId] } as Express.Request["actor"]);
    expect((await request(agentApp).get(`/api/companies/${f.companyId}/ai-health`)).status).toBe(403);
    const outsiderApp = appFor({ type: "board", source: "session", userId: "outsider", companyIds: [f.otherCompanyId], memberships: [{ companyId: f.otherCompanyId, status: "active", membershipRole: "owner" }] });
    expect((await request(outsiderApp).get(`/api/companies/${f.companyId}/ai-health`)).status).toBe(403);
  });
});
