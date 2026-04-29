import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  projects,
  rt2V33DomainEvents,
  rt2V33KnowledgeBridgePairings,
  rt2V33KnowledgeBridgeQueue,
  rt2V33GraphEdges,
  rt2V33GraphNodes,
  rt2V33DailyWikiPages,
  rt2V33KnowledgeSyncDecisions,
  rt2V33KnowledgeVaultSettings,
  rt2V33ProjectorEvents,
  rt2V33ProjectorState,
  rt2V33WikiPages,
  startEmbeddedPostgresTestDatabase,
  getEmbeddedPostgresTestSupport,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { rt2DomainEventService } from "../services/rt2-domain-events.js";
import { rt2KnowledgeRoutes } from "../routes/rt2-knowledge.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RT2 knowledge route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("rt2 knowledge routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let projectId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rt2-knowledge-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(rt2V33GraphEdges);
    await db.delete(rt2V33GraphNodes);
    await db.delete(rt2V33DailyWikiPages);
    await db.delete(rt2V33KnowledgeBridgeQueue);
    await db.delete(rt2V33KnowledgeBridgePairings);
    await db.delete(rt2V33KnowledgeSyncDecisions);
    await db.delete(rt2V33KnowledgeVaultSettings);
    await db.delete(rt2V33WikiPages);
    await db.delete(rt2V33ProjectorEvents);
    await db.delete(rt2V33ProjectorState);
    await db.delete(rt2V33DomainEvents);
    await db.delete(activityLog);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(actorCompanyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "board-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [actorCompanyId],
      };
      next();
    });
    app.use("/api", rt2KnowledgeRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function seed() {
    companyId = randomUUID();
    projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "RT2 Knowledge Routes Corp",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Route Project",
      status: "in_progress",
    });
    await rt2DomainEventService(db).append({
      companyId,
      eventType: "rt2.task.created",
      eventVersion: 1,
      actorType: "user",
      actorId: "board-user",
      entityType: "task",
      entityId: "task-route-1",
      payload: { projectId, taskIssueId: "task-route-1" },
      metadata: {},
      idempotencyKey: "knowledge-route-task-1",
    });
  }

  it("projects and returns company-scoped wiki pages", async () => {
    await seed();
    const app = await createApp(companyId);

    const projectResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/project`)
      .send({ limit: 10 });
    expect(projectResponse.status).toBe(200);
    expect(projectResponse.body).toEqual(
      expect.objectContaining({
        companyId,
        processedEvents: 1,
        pendingEvents: 0,
        wikiPages: expect.any(Number),
        graphNodes: expect.any(Number),
        graphEdges: expect.any(Number),
        lastProjectedAt: expect.any(String),
      }),
    );

    const listResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/wiki-pages`)
      .query({ pageType: "index", limit: 5 });
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.pages).toEqual([
      expect.objectContaining({
        pageKey: "index.md",
        pageType: "index",
      }),
    ]);

    const pageResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/wiki-page`)
      .query({ pageKey: "index.md" });
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.body.markdown).toContain("RT2 운영 지식 Index");

    const vaultResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/vault-export`)
      .query({ limit: 5 });
    expect(vaultResponse.status).toBe(200);
    expect(vaultResponse.body.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "index.md",
          content: expect.stringContaining("rt2_source_event_ids"),
        }),
      ]),
    );
    const importFiles = vaultResponse.body.files.map((file: { path: string; content: string }) => ({
      path: file.path,
      content: file.path === "index.md"
        ? `${file.content}\n\nImported operator note.\n`
        : file.content,
    }));

    const importPreviewResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-import-preview`)
      .send({
        vaultName: vaultResponse.body.vaultName,
        files: importFiles,
      });
    expect(importPreviewResponse.status).toBe(200);
    expect(importPreviewResponse.body).toEqual(
      expect.objectContaining({
        companyId,
        evidenceStatus: "ready",
        fileCount: vaultResponse.body.files.length,
        missingEventIds: [],
        candidates: expect.arrayContaining([
          expect.objectContaining({ kind: "wiki_page", targetKey: "index.md" }),
        ]),
      }),
    );

    const writerResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-writer`)
      .send({ rootPath: "C:/rt2-vault", exportSubdirectory: "rt2-export" });
    expect(writerResponse.status).toBe(200);
    expect(writerResponse.body.exportPath).toBe("C:/rt2-vault/rt2-export");
    expect(writerResponse.body.lastDryRun.fileCount).toBeGreaterThan(0);

    const approvedCandidateIds = importPreviewResponse.body.candidates
      .filter((candidate: { action: string }) => candidate.action !== "skip" && candidate.action !== "conflict")
      .map((candidate: { id: string }) => candidate.id);
    const applyResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-import-apply`)
      .send({
        vaultName: vaultResponse.body.vaultName,
        projectId,
        files: importFiles,
        approvedCandidateIds,
      });
    expect(applyResponse.status).toBe(200);
    expect(applyResponse.body.updatedWikiPages).toBeGreaterThanOrEqual(1);

    const conflictResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/vault-conflict-resolve`)
      .send({
        projectId,
        file: vaultResponse.body.files[0],
        decision: "rt2_wins",
        reason: "RT2 is source of truth",
      });
    expect(conflictResponse.status).toBe(200);
    expect(conflictResponse.body).toEqual(expect.objectContaining({ decision: "rt2_wins", applied: false }));
  });

  it("pairs a trusted local bridge and exposes sync health evidence", async () => {
    await seed();
    const app = await createApp(companyId);

    const emptyHealth = await request(app).get(`/api/companies/${companyId}/rt2/knowledge/local-bridge/health`);
    expect(emptyHealth.status).toBe(200);
    expect(emptyHealth.body).toEqual(expect.objectContaining({
      status: "unavailable",
      bridge: null,
      conflictCount: 0,
    }));
    expect(emptyHealth.body.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "bridge_unpaired" })]),
    );

    const pairing = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/local-bridge/pairing`)
      .send({ bridgeName: "Operator MacBook Bridge", vaultName: "Ops Vault" });
    expect(pairing.status).toBe(200);
    expect(pairing.body.bridge).toEqual(expect.objectContaining({
      companyId,
      bridgeName: "Operator MacBook Bridge",
      vaultName: "Ops Vault",
      status: "paired",
    }));
    expect(pairing.body.pairingToken).toContain("rt2lb_");

    const crossCompanyHeartbeat = await request(app)
      .post(`/api/companies/${randomUUID()}/rt2/knowledge/local-bridge/heartbeat`)
      .send({
        bridgeId: pairing.body.bridge.id,
        pairingToken: pairing.body.pairingToken,
        status: "available",
      });
    expect(crossCompanyHeartbeat.status).toBe(403);

    const badHeartbeat = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/local-bridge/heartbeat`)
      .send({
        bridgeId: pairing.body.bridge.id,
        pairingToken: "rt2lb_wrong_token_000000000000",
        status: "available",
      });
    expect(badHeartbeat.status).toBe(403);

    const heartbeat = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/local-bridge/heartbeat`)
      .send({
        bridgeId: pairing.body.bridge.id,
        pairingToken: pairing.body.pairingToken,
        status: "blocked",
        blockedReason: "Vault directory is locked by another process.",
        conflictCount: 2,
      });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toEqual(expect.objectContaining({
      status: "blocked",
      blockedReason: "Vault directory is locked by another process.",
      conflictCount: 2,
    }));

    const queued = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/local-bridge/sync-queue`)
      .send({
        operation: "export",
        vaultPath: "C:/rt2-vault/rt2-export/index.md",
        pageKey: "index.md",
      });
    expect(queued.status).toBe(200);
    expect(queued.body).toEqual(expect.objectContaining({
      operation: "export",
      status: "queued",
      pageKey: "index.md",
    }));

    const apply = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/local-bridge/sync-queue/apply`)
      .send({
        queueId: queued.body.id,
        status: "applied",
        result: { filesWritten: 1 },
      });
    expect(apply.status).toBe(200);
    expect(apply.body).toEqual(expect.objectContaining({
      status: "applied",
      result: expect.objectContaining({ filesWritten: 1 }),
    }));

    const health = await request(app).get(`/api/companies/${companyId}/rt2/knowledge/local-bridge/health`);
    expect(health.status).toBe(200);
    expect(health.body).toEqual(expect.objectContaining({
      status: "blocked",
      conflictCount: 2,
      blockedReason: "Vault directory is locked by another process.",
      lastAppliedAt: expect.any(String),
    }));
    expect(health.body.queue).toEqual(expect.objectContaining({ applied: 1 }));
  });

  it("returns daily wiki pages through roadmap-compatible daily endpoints", async () => {
    await seed();
    const app = await createApp(companyId);

    const rebuildResponse = await request(app)
      .post(`/api/companies/${companyId}/rt2/knowledge/daily/rebuild`)
      .send({});
    expect(rebuildResponse.status).toBe(200);
    expect(rebuildResponse.body.totalPages).toBeGreaterThanOrEqual(2);

    const date = new Date().toISOString().slice(0, 10);
    const pageResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/daily`)
      .query({ date });
    expect(pageResponse.status).toBe(200);
    expect(pageResponse.body).toEqual(
      expect.objectContaining({
        pageKey: `daily/${date}.md`,
        userId: "all",
      }),
    );

    const userPageResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/daily`)
      .query({ date, userId: "board-user" });
    expect(userPageResponse.status).toBe(200);
    expect(userPageResponse.body.pageKey).toBe(`daily/${date}/user/board-user.md`);

    const indexResponse = await request(app)
      .get(`/api/companies/${companyId}/rt2/knowledge/daily/index`)
      .query({ date });
    expect(indexResponse.status).toBe(200);
    expect(indexResponse.body.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageKey: `daily/${date}.md` }),
        expect.objectContaining({ pageKey: `daily/${date}/user/board-user.md` }),
      ]),
    );
  });
});
