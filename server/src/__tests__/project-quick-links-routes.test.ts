import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, projectQuickLinks, projects } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import type { ProjectQuickLinkPreviewFetcherOptions } from "../services/project-quick-link-preview.ts";
import { projectQuickLinkRoutes } from "../routes/project-quick-links.js";
import { errorHandler } from "../middleware/index.js";
import { createProjectQuickLinkPreviewFetcher } from "../services/project-quick-link-preview.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres project quick link route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type ActorMode = "local" | "company-1-only";

function publicLookup() {
  return Promise.resolve([{ address: "93.184.216.34", family: 4 }]);
}

function htmlResponse(html: string, init?: ResponseInit) {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", ...(init?.headers ?? {}) },
    ...init,
  });
}

describeEmbeddedPostgres("project quick link routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-quick-links-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(projectQuickLinks);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createApp(
    actorMode: ActorMode = "local",
    previewFetcherOptions?: ProjectQuickLinkPreviewFetcherOptions,
  ) {
    const previewFetcher = previewFetcherOptions
      ? createProjectQuickLinkPreviewFetcher(previewFetcherOptions)
      : undefined;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor =
        actorMode === "company-1-only"
          ? {
              type: "board",
              userId: "board-user",
              companyIds: ["company-1"],
              source: "session",
              isInstanceAdmin: false,
            }
          : {
              type: "board",
              userId: "board-user",
              companyIds: [],
              source: "local_implicit",
              isInstanceAdmin: false,
            };
      next();
    });
    app.use("/api", projectQuickLinkRoutes(db, { previewFetcher }));
    app.use(errorHandler);
    return app;
  }

  async function seedProject(input: { companyId?: string; projectId?: string; prefix?: string } = {}) {
    const companyId = input.companyId ?? randomUUID();
    const projectId = input.projectId ?? randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 4)}`,
      issuePrefix: input.prefix ?? `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Project",
      status: "in_progress",
    });
    return { companyId, projectId };
  }

  it("creates, lists, updates, deletes, and logs project quick links", async () => {
    const { companyId, projectId } = await seedProject();
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links`)
      .send({ url: "https://www.example.com/runbook" });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      companyId,
      projectId,
      title: "example.com",
      url: "https://www.example.com/runbook",
      position: 0,
      createdByUserId: "board-user",
    });

    const listed = await request(app).get(`/api/companies/${companyId}/projects/${projectId}/quick-links`);
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body).toHaveLength(1);

    const updated = await request(app)
      .patch(`/api/companies/${companyId}/projects/${projectId}/quick-links/${created.body.id}`)
      .send({ title: "Runbook", url: "https://docs.example.com/runbook" });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      title: "Runbook",
      url: "https://docs.example.com/runbook",
    });

    const removed = await request(app)
      .delete(`/api/companies/${companyId}/projects/${projectId}/quick-links/${created.body.id}`);

    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await request(app).get(`/api/companies/${companyId}/projects/${projectId}/quick-links`)).body).toEqual([]);

    const actions = await db
      .select({ action: activityLog.action })
      .from(activityLog);
    expect(actions.map((row) => row.action).sort()).toEqual([
      "project.quick_link_created",
      "project.quick_link_deleted",
      "project.quick_link_updated",
    ]);
  });

  it("previews quick link metadata through the route", async () => {
    const { companyId, projectId } = await seedProject();
    const previewFetcherOptions = {
      lookupHost: publicLookup,
      fetchImpl: async () => htmlResponse(`
        <html>
          <head>
            <meta property="og:title" content="Paperclip Docs" />
            <meta property="og:site_name" content="Paperclip" />
            <meta property="og:description" content="Control plane notes" />
            <meta property="og:image" content="/og.png" />
            <link rel="icon" href="/favicon.ico" />
          </head>
        </html>
      `),
    };

    const res = await request(await createApp("local", previewFetcherOptions))
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links/preview`)
      .send({ url: "https://docs.example.com/guide" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      url: "https://docs.example.com/guide",
      title: "Paperclip Docs",
      siteName: "Paperclip",
      description: "Control plane notes",
      imageUrl: "https://docs.example.com/og.png",
      faviconUrl: "https://docs.example.com/favicon.ico",
    });
  });

  it("falls back to HTML title and hostname when preview metadata is sparse", async () => {
    const { companyId, projectId } = await seedProject();
    const previewFetcherOptions = {
      lookupHost: publicLookup,
      fetchImpl: async () => htmlResponse("<html><head><title>Runbook</title></head></html>"),
    };

    const res = await request(await createApp("local", previewFetcherOptions))
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links/preview`)
      .send({ url: "https://www.example.com/runbook" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      title: "Runbook",
      siteName: "example.com",
      faviconUrl: "https://www.example.com/favicon.ico",
    });
  });

  it("blocks private preview targets", async () => {
    const { companyId, projectId } = await seedProject();
    const previewFetcherOptions = {
      lookupHost: async () => [{ address: "127.0.0.1", family: 4 }],
      fetchImpl: async () => htmlResponse("<html />"),
    };

    const res = await request(await createApp("local", previewFetcherOptions))
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links/preview`)
      .send({ url: "https://internal.example.com" });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/private hosts/);
  });

  it("enforces company access before previewing links", async () => {
    const { companyId, projectId } = await seedProject({ prefix: "PB3" });
    const res = await request(await createApp("company-1-only"))
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links/preview`)
      .send({ url: "https://example.com" });

    expect(res.status).toBe(403);
  });

  it("rejects invalid quick link URLs", async () => {
    const { companyId, projectId } = await seedProject();
    const res = await request(await createApp())
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links`)
      .send({ title: "Local", url: "file:///tmp/local.md" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
  });

  it("persists rich metadata and clears stale metadata when URLs change without preview data", async () => {
    const { companyId, projectId } = await seedProject();
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/quick-links`)
      .send({
        title: "Docs",
        url: "https://docs.example.com",
        siteName: "Docs Site",
        description: "Project docs",
        imageUrl: "https://docs.example.com/og.png",
        faviconUrl: "https://docs.example.com/favicon.ico",
      });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      siteName: "Docs Site",
      description: "Project docs",
      imageUrl: "https://docs.example.com/og.png",
      faviconUrl: "https://docs.example.com/favicon.ico",
    });
    expect(created.body.metadataFetchedAt).toBeTruthy();

    const updated = await request(app)
      .patch(`/api/companies/${companyId}/projects/${projectId}/quick-links/${created.body.id}`)
      .send({ url: "https://plain.example.com" });

    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body).toMatchObject({
      siteName: null,
      description: null,
      imageUrl: null,
      faviconUrl: null,
      metadataFetchedAt: null,
    });
  });

  it("enforces company access before reading links", async () => {
    const { companyId, projectId } = await seedProject({ prefix: "PB2" });
    const res = await request(await createApp("company-1-only"))
      .get(`/api/companies/${companyId}/projects/${projectId}/quick-links`);

    expect(res.status).toBe(403);
  });

  it("does not allow a link to be updated through another project", async () => {
    const alpha = await seedProject({ prefix: "PQA" });
    const beta = await seedProject({ prefix: "PQB" });
    const app = await createApp();

    const created = await request(app)
      .post(`/api/companies/${alpha.companyId}/projects/${alpha.projectId}/quick-links`)
      .send({ title: "Alpha", url: "https://alpha.example.com" });

    const crossProjectUpdate = await request(app)
      .patch(`/api/companies/${beta.companyId}/projects/${beta.projectId}/quick-links/${created.body.id}`)
      .send({ title: "Beta" });

    expect(crossProjectUpdate.status).toBe(404);
  });
});
