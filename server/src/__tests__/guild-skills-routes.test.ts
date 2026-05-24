/**
 * Plan 3 Phase F follow-up — guild-skills POST route emits the
 * `guild.worker.skills_ingested` activity_log action so the operator's
 * Telegram notifier sees skill creations regardless of whether the
 * worker took the exit-hook (learnings.json) path or POSTed directly.
 *
 * Pre-Phase-F-follow-up state: the POST route persisted the skill row
 * and returned 201 but emitted no activity, so workers that bypassed
 * the exit hook (e.g. ROC-75 during the F5 smoke) created skills
 * silently from the operator's perspective.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  skills,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

let errorHandler: typeof import("../middleware/index.js").errorHandler;
let guildSkillRoutes: typeof import("../routes/guild-skills.js").guildSkillRoutes;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres guild-skills route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /companies/:companyId/guilds/:guildId/skills (Plan 3 Phase F follow-up)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let guildId!: string;
  let userId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-guild-skills-route-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/guild-skills.js");
    vi.doUnmock("../middleware/index.js");
    const [routes, middleware] = await Promise.all([
      vi.importActual<typeof import("../routes/guild-skills.js")>("../routes/guild-skills.js"),
      vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    ]);
    guildSkillRoutes = routes.guildSkillRoutes;
    errorHandler = middleware.errorHandler;
    companyId = randomUUID();
    guildId = randomUUID();
    userId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "co-fixture",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: guildId,
      companyId,
      name: "eng-guild",
      kind: "guild",
    });
  });

  afterEach(async () => {
    await db.delete(skills);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: { type: "agent" | "board"; userId?: string; agentId?: string }) {
    if (!guildSkillRoutes || !errorHandler) {
      throw new Error("guild-skills route test dependencies were not loaded");
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Minimal local_implicit board actor — bypasses auth checks for
      // this focused route test. assertCompanyAccess accepts board +
      // local_implicit unconditionally; getActorInfo turns it into a
      // user-type actor.
      if (actor.type === "agent") {
        (req as any).actor = {
          type: "agent",
          source: "local_implicit",
          agentId: actor.agentId,
          companyId,
          runId: null,
        };
      } else {
        (req as any).actor = {
          type: "board",
          source: "local_implicit",
          userId: actor.userId,
          companyIds: [companyId],
        };
      }
      next();
    });
    app.use("/api", guildSkillRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("emits guild.worker.skills_ingested on successful skill creation, anchored on the guild", async () => {
    const app = createApp({ type: "board", userId });
    const res = await request(app)
      .post(`/api/companies/${companyId}/guilds/${guildId}/skills`)
      .send({ name: "operator-created-skill", body: "An operator wrote this directly." });
    expect(res.status).toBe(201);
    const createdSkillId = res.body.id as string;

    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.action, "guild.worker.skills_ingested"),
          eq(activityLog.entityId, createdSkillId),
        ),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.companyId).toBe(companyId);
    expect(row.entityType).toBe("guild_skill");
    // agent_id on the row is the GUILD (not the caller), matching the
    // exit-hook emission shape so "activity for guild X" filters work.
    expect(row.agentId).toBe(guildId);
    expect(row.actorType).toBe("user");

    const d = row.details as Record<string, unknown>;
    expect(d.source).toBe("direct-post");
    expect(d.guild_id).toBe(guildId);
    expect(d.guild_slug).toBe("eng-guild");
    expect(d.ingested_count).toBe(1);
    expect(d.rejected_count).toBe(0);
    expect(d.file_missing).toBe(false);
    const ingested = d.ingested as Array<{ id: string; name: string; body: string }>;
    expect(ingested).toHaveLength(1);
    expect(ingested[0]!.id).toBe(createdSkillId);
    expect(ingested[0]!.name).toBe("operator-created-skill");
    expect(ingested[0]!.body).toBe("An operator wrote this directly.");
  });

  it("includes createdByRunId on the emitted row when the request body carries one", async () => {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      agentId: guildId,
      companyId,
      reason: "on_demand",
      source: "manual",
      status: "succeeded",
    });
    const app = createApp({ type: "agent", agentId: randomUUID() });
    const res = await request(app)
      .post(`/api/companies/${companyId}/guilds/${guildId}/skills`)
      .send({
        name: "worker-bypassing-exit-hook",
        body: "ROC-75 path: worker POSTs directly instead of writing learnings.json.",
        createdByRunId: runId,
      });
    expect(res.status).toBe(201);

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "guild.worker.skills_ingested"));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // run_id column on the activity_log row + the run_id echoed in
    // details both line up with the request's createdByRunId.
    expect(row.runId).toBe(runId);
    expect((row.details as Record<string, unknown>).run_id).toBe(runId);
    expect(row.actorType).toBe("agent");
  });

  it("truncates long bodies in the emitted preview but persists the full body", async () => {
    const app = createApp({ type: "board", userId });
    const longBody = "x".repeat(800);
    const res = await request(app)
      .post(`/api/companies/${companyId}/guilds/${guildId}/skills`)
      .send({ name: "long-body-skill", body: longBody });
    expect(res.status).toBe(201);
    expect(res.body.body).toBe(longBody);

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "guild.worker.skills_ingested"));
    expect(rows).toHaveLength(1);
    const d = rows[0]!.details as Record<string, unknown>;
    const ingested = d.ingested as Array<{ body: string }>;
    const preview = ingested[0]!.body;
    expect(Array.from(preview)).toHaveLength(501);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.slice(0, 500)).toBe("x".repeat(500));
  });

  it("does NOT emit when the create call fails (duplicate non-retired name)", async () => {
    // Pre-seed an existing non-retired skill with the same name.
    await db.insert(skills).values({
      guildId,
      companyId,
      name: "already-exists",
      body: "existing body",
      provenance: "provisional",
    });
    const app = createApp({ type: "board", userId });
    const res = await request(app)
      .post(`/api/companies/${companyId}/guilds/${guildId}/skills`)
      .send({ name: "already-exists", body: "second attempt" });
    expect(res.status).toBeGreaterThanOrEqual(400);

    const rows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "guild.worker.skills_ingested"));
    expect(rows).toHaveLength(0);
  });
});
