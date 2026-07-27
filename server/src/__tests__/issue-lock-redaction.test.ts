import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueLockWebauthnRoutes } from "../routes/issue-lock-webauthn.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue-lock redaction tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// MAT-112 — issue-lock (variant A, UI gate) server behavior.
describeEmbeddedPostgres("issue-lock redaction + WebAuthn routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-lock-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const noopStorage: StorageService = {
    provider: "local_disk",
    putFile: vi.fn(async () => { throw new Error("unexpected putFile"); }),
    getObject: vi.fn(async () => { throw new Error("unexpected getObject"); }),
    headObject: vi.fn(async () => ({ exists: false })),
    deleteObject: vi.fn(async () => undefined),
  };

  function createApp(companyId: string, actorKind: "board" | "agent") {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actorKind === "board"
        ? {
            type: "board",
            userId: "board-user-1",
            userEmail: "matej@example.com",
            companyIds: [companyId],
            memberships: [{ companyId, membershipRole: "owner", status: "active" }],
            source: "cloud_tenant",
            isInstanceAdmin: false,
          }
        : {
            type: "agent",
            agentId: randomUUID(),
            companyId,
            companyIds: [companyId],
            source: "agent_key",
          };
      next();
    });
    app.use("/api", issueLockWebauthnRoutes(db));
    app.use("/api", issueRoutes(db, noopStorage));
    app.use(errorHandler);
    return app;
  }

  async function seed(opts: { locked: boolean }) {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Lock Co",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "LOCK-1",
      title: "Locked task title",
      description: "TOP SECRET description body",
      status: "todo",
      priority: "medium",
      locked: opts.locked,
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorUserId: "board-user-1",
      body: "SECRET comment body",
    });
    return { companyId, issueId };
  }

  it("withholds a locked issue's description + comments from a gated board actor", async () => {
    const { companyId, issueId } = await seed({ locked: true });
    const app = createApp(companyId, "board");

    const detail = await request(app).get(`/api/issues/${issueId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.locked).toBe(true);
    expect(detail.body.contentRedacted).toBe(true);
    expect(detail.body.description).toBeNull();
    // Title (meta) stays visible.
    expect(detail.body.title).toBe("Locked task title");
    expect(JSON.stringify(detail.body)).not.toContain("TOP SECRET");

    const comments = await request(app).get(`/api/issues/${issueId}/comments`);
    expect(comments.status).toBe(200);
    expect(comments.body).toEqual([]);
  });

  it("redacts locked-issue description previews in the company list, leaving unlocked issues intact", async () => {
    const { companyId, issueId: lockedId } = await seed({ locked: true });
    const unlockedId = randomUUID();
    await db.insert(issues).values({
      id: unlockedId,
      companyId,
      identifier: "LOCK-2",
      title: "Open task",
      description: "visible body",
      status: "todo",
      priority: "medium",
      locked: false,
    });

    const list = await request(createApp(companyId, "board")).get(`/api/companies/${companyId}/issues`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const rows: any[] = Array.isArray(list.body) ? list.body : list.body.issues;
    const lockedRow = rows.find((r) => r.id === lockedId);
    const openRow = rows.find((r) => r.id === unlockedId);
    expect(lockedRow.locked).toBe(true);
    expect(lockedRow.description).toBeNull();
    expect(lockedRow.contentRedacted).toBe(true);
    expect(openRow.description).not.toBeNull();
    expect(JSON.stringify(list.body)).not.toContain("TOP SECRET");
  });

  it("lets a board user toggle the lock, and content returns when unlocked", async () => {
    const { companyId, issueId } = await seed({ locked: false });
    const app = createApp(companyId, "board");

    // Unlocked issue: full content is visible to the board.
    const before = await request(app).get(`/api/issues/${issueId}`);
    expect(before.body.description).toBe("TOP SECRET description body");
    expect(before.body.contentRedacted).toBeUndefined();

    const lock = await request(app).patch(`/api/issues/${issueId}`).send({ locked: true });
    expect(lock.status, JSON.stringify(lock.body)).toBe(200);

    const locked = await request(app).get(`/api/issues/${issueId}`);
    expect(locked.body.locked).toBe(true);
    expect(locked.body.description).toBeNull();

    const unlock = await request(app).patch(`/api/issues/${issueId}`).send({ locked: false });
    expect(unlock.status).toBe(200);
    const after = await request(app).get(`/api/issues/${issueId}`);
    expect(after.body.locked).toBe(false);
    expect(after.body.description).toBe("TOP SECRET description body");
  });

  it("exposes WebAuthn status + registration options to board users, and 403s agents", async () => {
    const { companyId } = await seed({ locked: true });

    const status = await request(createApp(companyId, "board")).get("/api/webauthn/issue-lock/status");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ registered: false, unlocked: false, protectionScope: "ui_only" });

    const options = await request(createApp(companyId, "board"))
      .post("/api/webauthn/issue-lock/register/options")
      .send({});
    expect(options.status, JSON.stringify(options.body)).toBe(200);
    expect(typeof options.body.challenge).toBe("string");
    expect(options.body.rp?.id).toBeTruthy();
    expect(options.body.authenticatorSelection).toMatchObject({
      authenticatorAttachment: "platform",
      userVerification: "required",
    });

    const agentStatus = await request(createApp(companyId, "agent")).get("/api/webauthn/issue-lock/status");
    expect(agentStatus.status).toBe(403);
  });
});
