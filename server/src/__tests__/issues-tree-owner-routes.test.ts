import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres tree-owner route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue list tree-owner filtering routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  // "me" for the board actor below.
  const meUserId = "cloud-user-1";
  const otherUserId = "cloud-user-2";

  const myRoot = randomUUID();
  const myChild = randomUUID();
  const otherRoot = randomUUID();
  const unownedRoot = randomUUID();
  // Assigned to me but inside another user's tree (used to prove AND semantics).
  const otherRootAssignedToMe = randomUUID();
  const assignedChild = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tree-owner-routes-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Tree owner tenant",
      issuePrefix: "TOW",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: meUserId,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });

    await db.insert(issues).values([
      { id: myRoot, companyId, title: "My root", status: "todo", priority: "medium", createdByUserId: meUserId },
      { id: myChild, companyId, parentId: myRoot, title: "My child", status: "todo", priority: "medium", createdByUserId: otherUserId },
      { id: otherRoot, companyId, title: "Other root", status: "todo", priority: "medium", createdByUserId: otherUserId },
      { id: unownedRoot, companyId, title: "Unowned root", status: "todo", priority: "medium", createdByUserId: null },
      { id: otherRootAssignedToMe, companyId, title: "Other root w/ my assignee", status: "todo", priority: "medium", createdByUserId: otherUserId },
      { id: assignedChild, companyId, parentId: otherRootAssignedToMe, title: "Assigned to me", status: "todo", priority: "medium", createdByUserId: otherUserId, assigneeUserId: meUserId },
    ]);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createStorage(): StorageService {
    return {
      provider: "local_disk",
      putFile: vi.fn(async () => {
        throw new Error("Unexpected storage.putFile call in tree-owner route test");
      }),
      getObject: vi.fn(async () => {
        throw new Error("Unexpected storage.getObject call in tree-owner route test");
      }),
      headObject: vi.fn(async () => ({ exists: false })),
      deleteObject: vi.fn(async () => undefined),
    };
  }

  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, createStorage()));
    app.use(errorHandler);
    return app;
  }

  const boardApp = () =>
    createApp({
      type: "board",
      userId: meUserId,
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "owner", status: "active" }],
      source: "cloud_tenant",
      isInstanceAdmin: false,
    });

  function listIds(body: Array<{ id: string }>) {
    return new Set(body.map((issue) => issue.id));
  }

  it("resolves treeOwnerUserId=me to the board user and returns only their tree", async () => {
    const res = await request(boardApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ treeOwnerUserId: "me" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // My tree (root + child created by another user) only — no other-user or unowned trees.
    expect(listIds(res.body)).toEqual(new Set([myRoot, myChild]));
  });

  it("includes agent/system-spawned trees when includeUnownedTrees=true", async () => {
    const res = await request(boardApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ treeOwnerUserId: "me", includeUnownedTrees: "true" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(listIds(res.body)).toEqual(new Set([myRoot, myChild, unownedRoot]));
  });

  it("ANDs assigneeUserId=me with treeOwnerUserId=me consistently", async () => {
    // assigneeUserId=me alone surfaces the assigned child inside another user's tree.
    const assigneeOnly = await request(boardApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ assigneeUserId: "me" });
    expect(assigneeOnly.status).toBe(200);
    expect(listIds(assigneeOnly.body)).toEqual(new Set([assignedChild]));

    // Combined with treeOwnerUserId=me, that child is excluded because its tree
    // is owned by another user — the two filters intersect.
    const combined = await request(boardApp())
      .get(`/api/companies/${companyId}/issues`)
      .query({ assigneeUserId: "me", treeOwnerUserId: "me" });
    expect(combined.status).toBe(200);
    expect(listIds(combined.body)).toEqual(new Set());
  });

  it("rejects treeOwnerUserId=me for a non-board actor on list and count", async () => {
    const agentApp = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId,
      companyIds: [companyId],
      isInstanceAdmin: false,
    });

    const listRes = await request(agentApp)
      .get(`/api/companies/${companyId}/issues`)
      .query({ treeOwnerUserId: "me" });
    expect(listRes.status).toBe(403);
    expect(listRes.body.error).toMatch(/treeOwnerUserId=me requires board authentication/);

    const countRes = await request(agentApp)
      .get(`/api/companies/${companyId}/issues/count`)
      .query({ attention: "blocked", treeOwnerUserId: "me" });
    expect(countRes.status).toBe(403);
    expect(countRes.body.error).toMatch(/treeOwnerUserId=me requires board authentication/);
  });
});
