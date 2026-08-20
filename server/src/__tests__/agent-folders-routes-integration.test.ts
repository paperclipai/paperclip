/**
 * Phase 4 Integration Tests — Agent Folder REST API Routes
 *
 * These integration tests exercise the agent-folder REST endpoints end-to-end
 * with a real embedded Postgres database and supertest HTTP requests.
 * They verify the full request → authz → service → response cycle.
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import {
  agentFolders,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentFolderRoutes } from "../routes/agent-folders.js";
import { errorHandler } from "../middleware/index.js";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { resolveFolderInstructionsDir } from "../services/agent-instructions-inheritance.js";

// Mock logActivity to avoid needing the full activity log table infrastructure
vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/index.js")>();
  return {
    ...actual,
    logActivity: vi.fn().mockResolvedValue(undefined),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent folder route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent folder routes integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let app!: Express;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-folder-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    // Build a fresh Express app for each test with real DB
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "user-1",
        companyIds: [companyId],
        source: "session",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use("/api", agentFolderRoutes(db));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await db.delete(agentFolders).where(eq(agentFolders.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── Helpers ──────────────────────────────────────────────

  const baseUrl = (cid: string) => `/api/companies/${cid}/agent-folders`;

  async function createFolderInDb(name: string, parentId: string | null = null) {
    const [folder] = await db
      .insert(agentFolders)
      .values({
        companyId,
        name,
        slug: name.toLowerCase().replace(/\s+/g, "-"),
        sortOrder: 0,
        parentId,
        metadata: {},
      })
      .returning();
    return folder!;
  }

  async function createAgentInDb(name: string, folderId: string | null = null) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "general",
        adapterType: "process",
        folderId,
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    return agent!;
  }

  // ── GET list ────────────────────────────────────────────

  describe("GET /companies/:companyId/agent-folders", () => {
    it("returns empty list for new company", async () => {
      const res = await request(app).get(baseUrl(companyId));

      expect(res.status).toBe(200);
      expect(res.body.folders).toEqual([]);
      expect(res.body.totalCount).toBe(0);
    });

    it("returns created folders", async () => {
      await createFolderInDb("Engineering");
      await createFolderInDb("Design");

      const res = await request(app).get(baseUrl(companyId));

      expect(res.status).toBe(200);
      expect(res.body.totalCount).toBe(2);

      const names = res.body.folders.map((f: { name: string }) => f.name);
      expect(names).toEqual(expect.arrayContaining(["Engineering", "Design"]));
    });

    it("includes agentCount and descendantCount", async () => {
      const folder = await createFolderInDb("Team");
      const child = await createFolderInDb("Backend", folder.id);
      await createAgentInDb("Agent A", folder.id);
      await createAgentInDb("Agent B", child.id);

      const res = await request(app).get(baseUrl(companyId));

      const parentItem = res.body.folders.find(
        (f: { id: string }) => f.id === folder.id,
      );
      const childItem = res.body.folders.find(
        (f: { id: string }) => f.id === child.id,
      );

      // agentCount in list() counts agents whose folderId points to that specific folder
      // (not recursive — listAgentsInFolder is the recursive one)
      expect(parentItem.agentCount).toBe(1); // only Agent A directly in parent
      expect(parentItem.descendantCount).toBe(1); // one child folder
      expect(childItem.agentCount).toBe(1); // Agent B directly in child
      expect(childItem.descendantCount).toBe(0);
    });
  });

  // ── GET single ──────────────────────────────────────────

  describe("GET /companies/:companyId/agent-folders/:folderId", () => {
    it("returns a single folder", async () => {
      const folder = await createFolderInDb("Engineering");

      const res = await request(app).get(`${baseUrl(companyId)}/${folder.id}`);

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("Engineering");
    });

    it("returns 404 for non-existent folder", async () => {
      const res = await request(app).get(`${baseUrl(companyId)}/${randomUUID()}`);

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Folder not found");
    });
  });

  // ── POST create ────────────────────────────────────────

  describe("POST /companies/:companyId/agent-folders", () => {
    it("creates a root-level folder", async () => {
      const res = await request(app)
        .post(baseUrl(companyId))
        .send({ name: "Engineering" });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe("Engineering");
      expect(res.body.slug).toBe("engineering");
      expect(res.body.parentId).toBeNull();
    });

    it("creates a nested folder with parentId", async () => {
      const parent = await createFolderInDb("Engineering");

      const res = await request(app)
        .post(baseUrl(companyId))
        .send({ name: "Backend", parentId: parent.id });

      expect(res.status).toBe(201);
      expect(res.body.parentId).toBe(parent.id);
      expect(res.body.slug).toBe("backend");
    });

    it("accepts custom slug", async () => {
      const res = await request(app)
        .post(baseUrl(companyId))
        .send({ name: "My Folder", slug: "custom-slug" });

      expect(res.status).toBe(201);
      expect(res.body.slug).toBe("custom-slug");
    });

    it("accepts metadata", async () => {
      const res = await request(app)
        .post(baseUrl(companyId))
        .send({
          name: "Meta Folder",
          metadata: { role: "coordinator", priority: "high" },
        });

      expect(res.status).toBe(201);
      expect(res.body.metadata).toEqual({ role: "coordinator", priority: "high" });
    });

    it("rejects duplicate name under same parent (409)", async () => {
      await createFolderInDb("Engineering");

      const res = await request(app)
        .post(baseUrl(companyId))
        .send({ name: "Engineering" });

      expect(res.status).toBe(409);
    });

    it("rejects empty name (400)", async () => {
      const res = await request(app)
        .post(baseUrl(companyId))
        .send({ name: "  " });

      expect(res.status).toBe(400);
    });

    it("rejects non-existent parent (404)", async () => {
      const res = await request(app)
        .post(baseUrl(companyId))
        .send({ name: "Child", parentId: randomUUID() });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Parent folder not found");
    });
  });

  // ── PATCH update ───────────────────────────────────────

  describe("PATCH /companies/:companyId/agent-folders/:folderId", () => {
    it("updates folder name", async () => {
      const folder = await createFolderInDb("Old Name");

      const res = await request(app)
        .patch(`${baseUrl(companyId)}/${folder.id}`)
        .send({ name: "New Name" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe("New Name");
    });

    it("updates folder slug", async () => {
      const folder = await createFolderInDb("Team");

      const res = await request(app)
        .patch(`${baseUrl(companyId)}/${folder.id}`)
        .send({ slug: "renamed-team" });

      expect(res.status).toBe(200);
      expect(res.body.slug).toBe("renamed-team");
    });

    it("updates folder metadata", async () => {
      const folder = await createFolderInDb("Team");

      const res = await request(app)
        .patch(`${baseUrl(companyId)}/${folder.id}`)
        .send({ metadata: { role: "watchdog" } });

      expect(res.status).toBe(200);
      expect(res.body.metadata).toEqual({ role: "watchdog" });
    });

    it("returns 404 for non-existent folder", async () => {
      const res = await request(app)
        .patch(`${baseUrl(companyId)}/${randomUUID()}`)
        .send({ name: "X" });

      expect(res.status).toBe(404);
    });
  });

  // ── POST move folder ───────────────────────────────────

  describe("POST /companies/:companyId/agent-folders/:folderId/move", () => {
    it("moves folder to a new parent", async () => {
      const root = await createFolderInDb("Root");
      const oldParent = await createFolderInDb("Old Parent");
      const folder = await createFolderInDb("Child", oldParent.id);

      const res = await request(app)
        .post(`${baseUrl(companyId)}/${folder.id}/move`)
        .send({ parentId: root.id });

      expect(res.status).toBe(200);
      expect(res.body.parentId).toBe(root.id);
    });

    it("moves folder to root level (parentId null)", async () => {
      const parent = await createFolderInDb("Parent");
      const folder = await createFolderInDb("Child", parent.id);

      const res = await request(app)
        .post(`${baseUrl(companyId)}/${folder.id}/move`)
        .send({ parentId: null });

      expect(res.status).toBe(200);
      expect(res.body.parentId).toBeNull();
    });

    it("rejects move into own subtree (422)", async () => {
      const parent = await createFolderInDb("Parent");
      const child = await createFolderInDb("Child", parent.id);


      const res = await request(app)
        .post(`${baseUrl(companyId)}/${parent.id}/move`)
        .send({ parentId: child.id });

      expect(res.status).toBe(422);
    });

    it("rejects moving folder to itself (422)", async () => {
      const folder = await createFolderInDb("Folder");

      const res = await request(app)
        .post(`${baseUrl(companyId)}/${folder.id}/move`)
        .send({ parentId: folder.id });

      expect(res.status).toBe(422);
    });
  });

  // ── DELETE folder ─────────────────────────────────────

  describe("DELETE /companies/:companyId/agent-folders/:folderId", () => {
    it("deletes an empty folder", async () => {
      const folder = await createFolderInDb("To Delete");

      const res = await request(app).delete(`${baseUrl(companyId)}/${folder.id}`);

      expect(res.status).toBe(200);
      expect(res.body.deleted.id).toBe(folder.id);
    });

    it("returns 404 for non-existent folder", async () => {
      const res = await request(app).delete(`${baseUrl(companyId)}/${randomUUID()}`);
      expect(res.status).toBe(404);
    });

    it("rejects delete when folder has children (409)", async () => {
      const parent = await createFolderInDb("Parent");
      await createFolderInDb("Child", parent.id);

      const res = await request(app).delete(`${baseUrl(companyId)}/${parent.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("Move or delete nested folders first");
    });

    it("nullifies agents' folder_id on delete", async () => {
      const folder = await createFolderInDb("Team");
      const agent = await createAgentInDb("Agent A", folder.id);

      await request(app).delete(`${baseUrl(companyId)}/${folder.id}`);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });
  });

  // ── Agent assignment routes ───────────────────────────

  describe("POST /companies/:companyId/agent-folders/:folderId/agents", () => {
    it("assigns agents to a folder", async () => {
      const folder = await createFolderInDb("Team");
      const a1 = await createAgentInDb("Agent A");
      const a2 = await createAgentInDb("Agent B");

      const res = await request(app)
        .post(`${baseUrl(companyId)}/${folder.id}/agents`)
        .send({ agentIds: [a1.id, a2.id] });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("rejects empty agentIds array (400)", async () => {
      const folder = await createFolderInDb("Team");

      const res = await request(app)
        .post(`${baseUrl(companyId)}/${folder.id}/agents`)
        .send({ agentIds: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("agentIds array is required");
    });

    it("rejects assigning non-existent agents (404)", async () => {
      const folder = await createFolderInDb("Team");

      const res = await request(app)
        .post(`${baseUrl(companyId)}/${folder.id}/agents`)
        .send({ agentIds: [randomUUID()] });

      // The service throws notFound when agent count doesn't match
      expect(res.status).toBe(404);
    });

    it("rejects non-existent folder (404)", async () => {
      const res = await request(app)
        .post(`${baseUrl(companyId)}/${randomUUID()}/agents`)
        .send({ agentIds: [randomUUID()] });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Folder not found");
    });
  });

  describe("GET /companies/:companyId/agent-folders/:folderId/agents", () => {
    it("lists agents recursively across descendant folders", async () => {
      const parent = await createFolderInDb("Parent");
      const child = await createFolderInDb("Child", parent.id);
      await createAgentInDb("Agent A", parent.id);
      await createAgentInDb("Agent B", child.id);

      const res = await request(app).get(`${baseUrl(companyId)}/${parent.id}/agents`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((a: { name: string }) => a.name)).toEqual(
        expect.arrayContaining(["Agent A", "Agent B"]),
      );
    });

    it("returns empty for folder with no agents", async () => {
      const folder = await createFolderInDb("Empty");

      const res = await request(app).get(`${baseUrl(companyId)}/${folder.id}/agents`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe("POST /companies/:companyId/agent-folders/agents/:agentId/move", () => {
    it("moves an agent to a folder", async () => {
      const folder = await createFolderInDb("Team");
      const agent = await createAgentInDb("Agent A");

      const res = await request(app)
        .post(`${baseUrl(companyId)}/agents/${agent.id}/move`)
        .send({ folderId: folder.id });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBe(folder.id);
    });

    it("unassigns an agent by passing null folderId", async () => {
      const folder = await createFolderInDb("Team");
      const agent = await createAgentInDb("Agent A", folder.id);

      const res = await request(app)
        .post(`${baseUrl(companyId)}/agents/${agent.id}/move`)
        .send({ folderId: null });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });
  });

  // ── Phase 3: instructions-bundle ─────────────────────────────

  describe("GET /companies/:companyId/agent-folders/:folderId/instructions-bundle", () => {
    it("returns the folder's own AGENTS.md and inherited ancestor instructions", async () => {
      // Create parent → child folder hierarchy
      const parent = await createFolderInDb("Parent");
      const child = await createFolderInDb("Child", parent.id);

      // Write instructions to both folders on disk
      const parentDir = resolveFolderInstructionsDir(companyId, parent.id);
      const childDir = resolveFolderInstructionsDir(companyId, child.id);
      await fs.mkdir(parentDir, { recursive: true });
      await fs.mkdir(childDir, { recursive: true });
      await fs.writeFile(path.join(parentDir, "AGENTS.md"), "# Parent AGENTS");
      await fs.writeFile(path.join(childDir, "AGENTS.md"), "# Child AGENTS");

      const res = await request(app).get(
        `${baseUrl(companyId)}/${child.id}/instructions-bundle`,
      );

      expect(res.status).toBe(200);
      expect(res.body.folderId).toBe(child.id);
      expect(res.body.folderName).toBe("Child");
      expect(res.body.content).toBe("# Child AGENTS");
      expect(res.body.inherited).toHaveLength(1);
      expect(res.body.inherited[0].folderName).toBe("Parent");
      expect(res.body.inherited[0].content).toBe("# Parent AGENTS");

      // cleanup
      await fs.rm(parentDir, { recursive: true, force: true });
      await fs.rm(childDir, { recursive: true, force: true });
    });

    it("returns null content when no instructions exist", async () => {
      const child = await createFolderInDb("Lonely");

      const res = await request(app).get(
        `${baseUrl(companyId)}/${child.id}/instructions-bundle`,
      );

      expect(res.status).toBe(200);
      expect(res.body.folderName).toBe("Lonely");
      expect(res.body.content).toBeNull();
      expect(res.body.inherited).toEqual([]);
    });

    it("returns 404 for a non-existent folder", async () => {
      const fakeId = "00000000-0000-4000-8000-000000000000";
      const res = await request(app).get(
        `${baseUrl(companyId)}/${fakeId}/instructions-bundle`,
      );
      expect(res.status).toBe(404);
    });

    it("respects the ?path= query to read a different file", async () => {
      const child = await createFolderInDb("Child");
      const childDir = resolveFolderInstructionsDir(companyId, child.id);
      await fs.mkdir(childDir, { recursive: true });
      await fs.writeFile(path.join(childDir, "SYSTEM.md"), "system content");

      const res = await request(app).get(
        `${baseUrl(companyId)}/${child.id}/instructions-bundle?path=SYSTEM.md`,
      );
      expect(res.status).toBe(200);
      expect(res.body.content).toBe("system content");

      await fs.rm(childDir, { recursive: true, force: true });
    });

    it("returns 422 for a traversal path (containment enforced at the HTTP layer)", async () => {
      const folder = await createFolderInDb("Contain HTTP");
      const res = await request(app).get(
        `${baseUrl(companyId)}/${folder.id}/instructions-bundle?path=${encodeURIComponent("../../../../etc/passwd")}`,
      );
      expect(res.status).toBe(422);
    });
  });
});
