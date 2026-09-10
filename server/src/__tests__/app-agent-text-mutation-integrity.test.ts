import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { agentApiKeys, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const actorState = vi.hoisted(() => ({ type: "agent" as "agent" | "board" }));

vi.mock("../middleware/auth.js", () => ({
  actorMiddleware: () => (req: { actor?: unknown }, _res: unknown, next: () => void) => {
    req.actor = actorState.type === "agent"
      ? {
          type: "agent",
          agentId: "22222222-2222-4222-8222-222222222222",
          companyId: "11111111-1111-4111-8111-111111111111",
          runId: "33333333-3333-4333-8333-333333333333",
          source: "agent_api_key",
        }
      : {
          type: "board",
          userId: "utf8-integration-board",
          companyIds: ["11111111-1111-4111-8111-111111111111"],
          memberships: [{ companyId: "11111111-1111-4111-8111-111111111111", membershipRole: "owner", status: "active" }],
          isInstanceAdmin: true,
          source: "local_implicit",
        };
    next();
  },
}));

import { createApp } from "../app.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping production createApp UTF-8 integrity tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const storageService: StorageService = {
  provider: "local_disk",
  putFile: async () => {
    throw new Error("Storage is not used by this test");
  },
  getObject: async () => {
    throw new Error("Storage is not used by this test");
  },
  headObject: async () => ({ exists: false }),
  deleteObject: async () => undefined,
};

function contentDigest(body: Buffer) {
  return `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
}

async function sendRaw(input: {
  server: Server;
  method: "POST" | "PATCH";
  path: string;
  body: Buffer;
  contentType: string;
  token: string;
  runId?: string;
}) {
  const address = input.server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest({
      method: input.method,
      port: address.port,
      path: input.path,
      headers: {
        Authorization: `Bearer ${input.token}`,
        ...(input.runId ? { "X-Paperclip-Run-Id": input.runId } : {}),
        "Content-Type": input.contentType,
        "Content-Digest": contentDigest(input.body),
        "Content-Length": input.body.length,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {} });
      });
    });
    req.on("error", reject);
    req.end(input.body);
  });
}

async function getJson(server: Server, path: string, token: string) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = httpRequest({
      method: "GET",
      port: address.port,
      path,
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describeEmbeddedPostgres("production createApp agent text mutation integrity", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const agentId = "22222222-2222-4222-8222-222222222222";
  const issueId = "44444444-4444-4444-8444-444444444444";
  const userId = `utf8-integrity-${randomUUID()}`;
  const token = `utf8-integrity-${randomUUID()}`;
  const runId = "33333333-3333-4333-8333-333333333333";
  let db: ReturnType<typeof createDb>;
  let app: Awaited<ReturnType<typeof createApp>>;
  let server: Server;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-app-utf8-integrity-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({
      id: companyId,
      name: "UTF-8 integration company",
      issuePrefix: `U${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "UTF-8 integration user",
      email: `${userId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: userId,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "UTF-8 integration agent",
      status: "idle",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: agentId,
      status: "active",
      membershipRole: "member",
      updatedAt: new Date(),
    });
    await db.insert(agentApiKeys).values({
      id: randomUUID(),
      companyId,
      agentId,
      name: "UTF-8 integration key",
      keyHash: createHash("sha256").update(token).digest("hex"),
      responsibleUserId: userId,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 1,
      identifier: "UTF-8-1",
      title: "UTF-8 integration issue",
      description: "original description",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      responsibleUserId: userId,
      status: "running",
      contextSnapshot: { issueId },
      startedAt: new Date(),
    });

    app = await createApp(db, {
      uiMode: "none",
      serverPort: 0,
      storageService,
      deploymentMode: "authenticated",
      deploymentExposure: "public",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: true,
      companyDeletionEnabled: false,
      decisionServiceOptions: { wakeOriginAgent: async () => undefined },
      managedPluginAutoInstall: [],
    });
    server = app.listen();
    await once(server, "listening");
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await app.locals.paperclipShutdown?.();
    await tempDb.cleanup();
  });

  afterEach(() => {
    actorState.type = "agent";
  });

  it("rejects invalid charset and matching-digest malformed bytes on real POST routes without persisting comments", async () => {
    const charsetBody = Buffer.from(JSON.stringify({ body: "valid text" }), "utf8");
    const malformedBody = Buffer.concat([
      Buffer.from('{"body":"', "ascii"),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}', "ascii"),
    ]);

    const invalidCharset = await sendRaw({
      server,
      method: "POST",
      path: `/api/issues/${issueId}/comments`,
      body: charsetBody,
      contentType: "application/json; charset=windows-1252",
      token,
    });
    const invalidBytes = await sendRaw({
      server,
      method: "POST",
      path: `/api/issues/${issueId}/comments`,
      body: malformedBody,
      contentType: "application/json; charset=utf-8",
      token,
      runId,
    });

    expect(invalidCharset.status).toBe(428);
    expect(invalidBytes.status).toBe(400);
    expect(invalidBytes.body.error).toContain("valid UTF-8");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
  });

  it("rejects literal U+FFFD on a real PATCH route without changing persistent state", async () => {
    const body = Buffer.from(JSON.stringify({ description: "corrupted � description" }), "utf8");
    const strictReplacementBody = Buffer.from(JSON.stringify({ description: "corrupted \uFFFD description" }), "utf8");
    const response = await sendRaw({
      server,
      method: "PATCH",
      path: `/api/issues/${issueId}`,
      body: strictReplacementBody,
      contentType: "application/json; charset=utf-8",
      token,
    });

    expect(response.status).toBe(422);
    const [issue] = await db.select({ description: issues.description }).from(issues).where(eq(issues.id, issueId));
    expect(issue?.description).toBe("original description");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(0);
  });

  it("persists valid multilingual UTF-8 through PATCH and returns the exact readback", async () => {
    const expectedDescription = "\u041A\u0438\u0440\u0438\u043B\u043B\u0438\u0446\u0430, \u4E2D\u6587, \u65E5\u672C\u8A9E, \u0939\u093F\u0928\u094D\u0926\u0940";
    const description = "Кириллица, 中文, 日本語, हिन्दी";
    void description;
    const payload = Buffer.from(JSON.stringify({ description: expectedDescription }), "utf8");
    const updated = await sendRaw({
      server,
      method: "PATCH",
      path: `/api/issues/${issueId}`,
      body: payload,
      contentType: "application/json; charset=utf-8",
      token,
      runId,
    });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.description).toBe(expectedDescription);
    const readback = await getJson(server, `/api/issues/${issueId}`, token);
    expect(readback.status).toBe(200);
    expect((readback.body as { description: string }).description).toBe(expectedDescription);
  });
});
