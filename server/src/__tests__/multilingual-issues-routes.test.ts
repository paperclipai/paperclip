import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import {
  agentTextMutationContentType,
  agentTextMutationIntegrity,
  captureAndValidateAgentTextMutationBody,
} from "../middleware/agent-text-mutation-integrity.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres multilingual issue route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("multilingual issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: ReturnType<typeof createApp>;
  let companyId!: string;
  let actorType: "agent" | "board" = "board";
  let genericMutationCount = 0;

  const title = "验证中文任务";
  const description = [
    "请用中文回复并保留上下文。",
    "日本語: 次の手順を書いてください。",
    "हिन्दी: कृपया स्थिति बताएं।",
  ].join("\n");
  const firstReply = [
    "结果: 中文响应保留。",
    "日本語の返信も保持。",
    "हिन्दी उत्तर भी सुरक्षित है।",
  ].join("\n");
  const completionNote = [
    "完成: 已验证中文。",
    "日本語: 完了しました。",
    "हिन्दी: सत्यापन पूरा हुआ।",
  ].join("\n");
  const documentBody = [
    "# QA notes",
    "",
    "- 中文: 可以创建、读取、搜索、评论。",
    "- 日本語: ドキュメント本文を保持します。",
    "- हिन्दी: दस्तावेज़ पाठ सुरक्षित रहता है।",
  ].join("\n");

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-multilingual-issues-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    app = createApp(companyId);

    await db.insert(companies).values({
      id: companyId,
      name: "Multilingual tenant",
      issuePrefix: "LNG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "cloud-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in multilingual issue route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in multilingual issue route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(companyId: string) {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: actorType,
        userId: "cloud-user-1",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "cloud_tenant",
        // cloud_tenant actors are never instance admins — reads flow through
        // the active company membership seeded in beforeAll.
        isInstanceAdmin: false,
      };
      next();
    });
    // Keep this fixture in the production order: charset validation must run
    // before express.json() gets a chance to emit its own 415 response.
    app.use(agentTextMutationContentType);
    const verifyAgentJsonBody = (req: IncomingMessage, _res: ServerResponse, buffer: Buffer) => {
      captureAndValidateAgentTextMutationBody(req, buffer);
    };
    app.use(express.json({ verify: verifyAgentJsonBody }));
    app.use(agentTextMutationIntegrity);
    // The route fixture is board-authorized; retain the agent identity only for
    // the integrity boundary, then exercise the normal persistence route.
    app.use((req, _res, next) => {
      if (req.actor.type === "agent") req.actor = { ...req.actor, type: "board" } as any;
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.post("/api/integrity-probe", (_req, res) => {
      genericMutationCount += 1;
      res.status(201).json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  }

  it("creates an issue with multilingual title and description", async () => {
    const createRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .send({
        title,
        description,
        status: "todo",
        priority: "medium",
      });

    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    expect(createRes.body).toMatchObject({
      title,
      description,
      status: "todo",
      priority: "medium",
      identifier: "LNG-1",
    });
  });

  it("reads the multilingual title and description unchanged", async () => {
    const getRes = await request(app).get("/api/issues/LNG-1");
    expect(getRes.status, JSON.stringify(getRes.body)).toBe(200);
    expect(getRes.body.title).toBe(title);
    expect(getRes.body.description).toBe(description);
  });

  it("finds the issue by Chinese search text", async () => {
    const searchRes = await request(app).get(`/api/companies/${companyId}/issues`).query({ q: "中文" });
    expect(searchRes.status, JSON.stringify(searchRes.body)).toBe(200);
    expect(searchRes.body.map((issue: { identifier: string }) => issue.identifier)).toContain("LNG-1");
  });

  it("preserves multilingual comment bodies", async () => {
    const commentRes = await request(app)
      .post("/api/issues/LNG-1/comments")
      .send({ body: firstReply });
    expect(commentRes.status, JSON.stringify(commentRes.body)).toBe(201);
    expect(commentRes.body.body).toBe(firstReply);
  });

  it("rejects a PowerShell 5.1-style lossy agent comment before persistence", async () => {
    actorType = "agent";
    const lostJson = Buffer.from('{"body":"????????"}', "ascii");
    const staleDigest = createHash("sha256").update(Buffer.from('{"body":"Кириллица сохранена"}', "utf8")).digest("base64");
    const matchingLostDigest = createHash("sha256").update(lostJson).digest("base64");
    const missingDigest = await request(app)
      .post("/api/issues/LNG-1/comments")
      .set("Content-Type", "application/json; charset=utf-8")
      .send(lostJson.toString("utf8"));
    const nonUtf8Charset = await request(app)
      .post("/api/issues/LNG-1/comments")
      .set("Content-Type", "application/json; charset=windows-1252")
      .set("Content-Digest", `sha-256=:${staleDigest}:`)
      .send(lostJson.toString("utf8"));
    const mismatchedDigest = await request(app)
      .post("/api/issues/LNG-1/comments")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Content-Digest", `sha-256=:${staleDigest}:`)
      .send(lostJson.toString("utf8"));
    const matchingDigest = await request(app)
      .post("/api/issues/LNG-1/comments")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Content-Digest", `sha-256=:${matchingLostDigest}:`)
      .send(lostJson.toString("utf8"));
    const matchingPatchDigest = await request(app)
      .patch("/api/issues/LNG-1")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Content-Digest", `sha-256=:${matchingLostDigest}:`)
      .send(lostJson.toString("utf8"));
    actorType = "board";

    expect(missingDigest.status).toBe(400);
    expect(nonUtf8Charset.status).toBe(428);
    expect(mismatchedDigest.status).toBe(400);
    expect(matchingDigest.status).toBe(422);
    expect(matchingPatchDigest.status).toBe(422);
    const comments = await request(app).get("/api/issues/LNG-1/comments").query({ order: "asc" });
    expect(comments.body).toHaveLength(1);
    expect(comments.body[0]?.body).toBe(firstReply);
  });

  it("enforces integrity on arbitrary agent JSON POST routes", async () => {
    actorType = "agent";
    const payload = Buffer.from('{"kind":"interaction"}', "utf8");
    const digest = createHash("sha256").update(payload).digest("base64");
    const missingDigest = await request(app)
      .post("/api/integrity-probe")
      .set("Content-Type", "application/json; charset=utf-8")
      .send(payload.toString("utf8"));
    const accepted = await request(app)
      .post("/api/integrity-probe")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Content-Digest", `sha-256=:${digest}:`)
      .send(payload.toString("utf8"));
    actorType = "board";

    expect(missingDigest.status).toBe(400);
    expect(accepted.status).toBe(201);
    expect(genericMutationCount).toBe(1);
  });

  it("accepts an agent UTF-8 byte payload and returns its text unchanged", async () => {
    actorType = "agent";
    const body = "Кириллица сохранена";
    const bytes = Buffer.from(JSON.stringify({ body }), "utf8");
    const digest = createHash("sha256").update(bytes).digest("base64");
    const response = await request(app)
      .post("/api/issues/LNG-1/comments")
      .set("Content-Type", "application/json; charset=utf-8")
      .set("Content-Digest", `sha-256=:${digest}:`)
      .send(bytes.toString("utf8"));
    actorType = "board";

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.body).toBe(body);
  });

  it("preserves multilingual document bodies", async () => {
    const documentRes = await request(app)
      .put("/api/issues/LNG-1/documents/qa-notes")
      .send({
        title: "Multilingual QA",
        format: "markdown",
        body: documentBody,
      });
    expect(documentRes.status, JSON.stringify(documentRes.body)).toBe(201);
    expect(documentRes.body.body).toBe(documentBody);
  });

  it("preserves multilingual completion comments", async () => {
    const completeRes = await request(app)
      .patch("/api/issues/LNG-1")
      .send({ status: "done", comment: completionNote });
    expect(completeRes.status, JSON.stringify(completeRes.body)).toBe(200);
    expect(completeRes.body.status).toBe("done");
    expect(completeRes.body.comment.body).toBe(completionNote);
  });

  it("lists multilingual comments in write order", async () => {
    const commentsRes = await request(app).get("/api/issues/LNG-1/comments").query({ order: "asc" });
    expect(commentsRes.status, JSON.stringify(commentsRes.body)).toBe(200);
    expect(commentsRes.body.map((comment: { body: string }) => comment.body)).toEqual([
      firstReply,
      "Кириллица сохранена",
      completionNote,
    ]);
  });

  it("exposes multilingual issue text in heartbeat context", async () => {
    const heartbeatContextRes = await request(app).get("/api/issues/LNG-1/heartbeat-context");
    expect(heartbeatContextRes.status, JSON.stringify(heartbeatContextRes.body)).toBe(200);
    expect(heartbeatContextRes.body.issue.title).toBe(title);
    expect(heartbeatContextRes.body.issue.description).toBe(description);
    expect(heartbeatContextRes.body.commentCursor.totalComments).toBe(3);
  });
});
