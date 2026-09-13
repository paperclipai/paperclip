import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, startEmbeddedPostgresTestDatabase, workFolderRuns, type Db } from "@paperclipai/db";
import { workFolderRoutes } from "../routes/work-folders.js";
import { errorHandler } from "../middleware/error-handler.js";
import { workFolderService } from "../services/work-folders.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import type { AuthorizationActor } from "../services/authorization.js";

describe("work folder HTTP ownership and streaming", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db, root: string;
  let storage: ReturnType<typeof createLocalDiskStorageProvider>;
  const companyId = randomUUID(), otherCompanyId = randomUUID(), ownerId = randomUUID(), otherUserId = randomUUID(), agentId = randomUUID();
  const base = `/api/companies/${companyId}/work-folders/user/${ownerId}`;
  const owner: AuthorizationActor = { type: "board", source: "session", userId: ownerId, companyIds: [companyId] };
  function app(actor: AuthorizationActor) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
    server.use("/api", workFolderRoutes(db, storage));
    server.use(errorHandler);
    return server;
  }
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-work-folder-routes-"); db = createDb(database.connectionString);
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-work-folder-http-")); storage = createLocalDiskStorageProvider(root);
    await db.insert(companies).values([{ id: companyId, name: "Files", issuePrefix: "FIL" }, { id: otherCompanyId, name: "Other", issuePrefix: "OTH" }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner" });
    for (const id of [ownerId, otherUserId]) {
      await db.insert(authUsers).values({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: id, membershipRole: "owner", status: "active" });
    }
  }, 60_000);
  afterAll(async () => { await database?.cleanup(); if (root) await rm(root, { recursive: true, force: true }); });
  it("uploads empty files and streams nested content with safe download headers", async () => {
    await request(app(owner)).put(`${base}/content?path=empty`).set("Content-Type", "application/octet-stream").send(Buffer.alloc(0)).expect(200);
    const body = Buffer.from("#!/bin/sh\ntrue\n");
    await request(app(owner)).put(`${base}/content?path=bin/run`).set("Content-Type", "application/octet-stream")
      .set("X-File-Executable", "true").send(body).expect(200);
    const listed = await request(app(owner)).get(base).expect(200);
    expect(listed.body.files.find((file: { path: string }) => file.path === "empty").byteSize).toBe(0);
    expect(listed.body.files.find((file: { path: string }) => file.path === "bin/run").executable).toBe(true);
    const downloaded = await request(app(owner)).get(`${base}/content?path=bin/run`).expect(200);
    expect(downloaded.body).toEqual(body);
    expect(downloaded.headers["content-security-policy"]).toContain("sandbox");
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
  });
  it("denies another company member every private-file operation", async () => {
    const other = app({ type: "board", source: "session", userId: otherUserId, companyIds: [companyId] });
    await request(other).get(base).expect(404);
    await request(other).get(`${base}/content?path=empty`).expect(404);
    await request(other).put(`${base}/content?path=empty`).set("Content-Type", "application/octet-stream").send("changed").expect(404);
    for (const action of ["delete", "mkdir", "restore", "purge"]) await request(other).post(`${base}/operations`).send({ action, path: "empty", fileId: randomUUID() }).expect(404);
    await request(other).get(`${base}/sync`).expect(404);
    await request(other).post(`${base}/refresh`).send({ runId: randomUUID() }).expect(404);
    const foreign = app({ type: "agent", source: "agent_key", companyId: otherCompanyId, agentId: randomUUID() });
    await request(foreign).get(base).expect(404);
  });
  it("authorizes a bound running agent and immediately honors membership revocation", async () => {
    const folder = await workFolderService(db, storage).ensure({ companyId, scope: "user", ownerId });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: ownerId, status: "running" });
    await db.insert(workFolderRuns).values({ runId, companyId, manifest: { version: 1, companyId, runId, agentId,
      taskId: null, responsibleUserId: ownerId, projectId: null, leaseId: randomUUID(), sandboxKey: randomUUID(), home: "/home/daytona",
      folders: { task: null, agent: null, user: folder.id, project: null }, repositories: [] } });
    const runApp = app({ type: "agent", source: "agent_jwt", companyId, agentId, runId, onBehalfOfUserId: ownerId });
    await request(runApp).get(base).expect(200);
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, ownerId)));
    await request(runApp).get(base).expect(404);
    await db.update(companyMemberships).set({ status: "active" }).where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, ownerId)));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await request(runApp).get(base).expect(404);
  });
});
