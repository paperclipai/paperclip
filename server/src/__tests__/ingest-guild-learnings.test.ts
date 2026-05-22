/**
 * Plan 3 Phase E2a — worker-exit learnings ingestion tests.
 *
 * Exercises ingestGuildLearnings end-to-end against embedded Postgres
 * + the real guildSkillService. The tests cover happy path, missing
 * file, malformed JSON, invalid name regex, body over the 8 KB cap,
 * duplicate canonical name, mixed valid+invalid array, top-level
 * shape mismatch, and the defense-in-depth kind!='guild' branch.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  skills,
} from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { ingestGuildLearnings } from "../dispatch/ingest-guild-learnings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ingest-guild-learnings tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ingestGuildLearnings (Plan 3 Phase E2a)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let sandboxRoot!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("ingest-guild-learnings-");
    db = createDb(tempDb.connectionString);
    sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ingest-guild-test-"));
  }, 20_000);

  afterEach(async () => {
    // This file never invokes the heartbeat service — it calls
    // `ingestGuildLearnings` directly. So there's no dispatcher tail
    // racing the cleanup. Embedded Postgres is per-file via the
    // `ingest-guild-learnings-` prefix, so other test files writing
    // to their own DBs can't pollute this one either. A simple
    // FK-aware delete chain is sufficient.
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(skills);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
    await tempDb?.cleanup();
  });

  async function seed(kind: "guild" | "agent" = "guild") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `co-${companyId.slice(0, 8)}`,
      issuePrefix: companyId.replace(/-/g, "").slice(0, 6).toUpperCase(),
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `${kind}-${agentId.slice(0, 8)}`,
      kind,
    });
    return { companyId, agentId, kind };
  }

  /** Insert a terminal heartbeat_runs row so the FK constraint on
   * skills.created_by_run_id is satisfied. In production, the hook
   * only runs after setRunStatus has already inserted the row. */
  async function seedRun(companyId: string, agentId: string): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      agentId,
      companyId,
      reason: "on_demand",
      source: "manual",
      status: "succeeded",
    });
    return runId;
  }

  async function withSandbox(
    fileBody: string | null,
  ): Promise<{ sandboxDir: string; cleanup: () => Promise<void> }> {
    const sandboxDir = await fs.mkdtemp(path.join(sandboxRoot, "sandbox-"));
    if (fileBody !== null) {
      await fs.writeFile(path.join(sandboxDir, "learnings.json"), fileBody, "utf-8");
    }
    return {
      sandboxDir,
      cleanup: () => fs.rm(sandboxDir, { recursive: true, force: true }).then(() => {}),
    };
  }

  it("happy path: writes two provisional skills with createdByRunId set", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [
          { name: "redis-connection-pooling", body: "use a pool size of 20" },
          { name: "drizzle-fk-cascade-trap", body: "FK cascade can silently delete sibling rows" },
        ],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    expect(result.fileMissing).toBe(false);
    expect(result.topLevelError).toBeNull();
    expect(result.rejected).toEqual([]);
    expect(result.ingested).toHaveLength(2);
    expect(result.ingested.map((s) => s.name).sort()).toEqual([
      "drizzle-fk-cascade-trap",
      "redis-connection-pooling",
    ]);
    // Phase F follow-up: body is included on each ingested entry so
    // the downstream notifier can render a preview without re-fetching.
    const byName = new Map(result.ingested.map((s) => [s.name, s.body]));
    expect(byName.get("redis-connection-pooling")).toBe("use a pool size of 20");
    expect(byName.get("drizzle-fk-cascade-trap")).toBe(
      "FK cascade can silently delete sibling rows",
    );

    const persisted = await db.select().from(skills);
    expect(persisted).toHaveLength(2);
    for (const row of persisted) {
      expect(row.provenance).toBe("provisional");
      expect(row.guildId).toBe(agentId);
      expect(row.companyId).toBe(companyId);
      expect(row.createdByRunId).toBe(runId);
    }
    await cleanup();
  });

  it("body field on ingested[] is truncated to the preview cap with an ellipsis", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    // 700 chars — well over the 500-codepoint preview cap but under
    // the 8 KB validator cap, so the row persists but the activity
    // preview must trim.
    const longBody = "a".repeat(700);
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({ skills: [{ name: "long-skill", body: longBody }] }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    expect(result.ingested).toHaveLength(1);
    const preview = result.ingested[0]!.body;
    // 500 codepoints + trailing ellipsis = 501 codepoints total.
    expect(Array.from(preview)).toHaveLength(501);
    expect(preview.endsWith("…")).toBe(true);
    expect(preview.slice(0, 500)).toBe("a".repeat(500));

    // The persisted row still has the FULL body — the preview is only
    // a derived field on the result, not a destructive transformation.
    const persisted = await db.select().from(skills);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.body).toBe(longBody);
    await cleanup();
  });

  it("missing learnings.json is treated as 'fileMissing', not an error", async () => {
    const { companyId, agentId } = await seed("guild");
    const { sandboxDir, cleanup } = await withSandbox(null);

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.fileMissing).toBe(true);
    expect(result.topLevelError).toBeNull();
    expect(result.ingested).toEqual([]);
    expect(result.rejected).toEqual([]);
    await cleanup();
  });

  it("malformed JSON sets topLevelError and ingests nothing", async () => {
    const { companyId, agentId } = await seed("guild");
    const { sandboxDir, cleanup } = await withSandbox("{this is not json}");

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.fileMissing).toBe(false);
    expect(result.topLevelError).toMatch(/valid JSON/);
    expect(result.ingested).toEqual([]);
    expect(result.rejected).toEqual([]);
    await cleanup();
  });

  it("top-level shape mismatch (no skills array) is reported, ingests nothing", async () => {
    const { companyId, agentId } = await seed("guild");
    const { sandboxDir, cleanup } = await withSandbox(JSON.stringify({ notes: "wrong shape" }));

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.topLevelError).toMatch(/skills/);
    expect(result.ingested).toEqual([]);
    await cleanup();
  });

  it("invalid name regex is rejected (kebab-case enforced); siblings unaffected", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [
          { name: "Has-Uppercase", body: "rejected" },
          { name: "ok-name", body: "accepted" },
        ],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    expect(result.ingested).toHaveLength(1);
    expect(result.ingested[0]?.name).toBe("ok-name");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe("Has-Uppercase");

    const persisted = await db.select().from(skills);
    expect(persisted).toHaveLength(1);
    await cleanup();
  });

  it("body over 8 KB is rejected", async () => {
    const { companyId, agentId } = await seed("guild");
    const overcap = "x".repeat(8193);
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({ skills: [{ name: "too-large", body: overcap }] }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.ingested).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe("too-large");
    await cleanup();
  });

  it("duplicate name (existing canonical) is rejected; original survives", async () => {
    const { companyId, agentId } = await seed("guild");
    // Pre-seed a canonical skill that the worker tries to clobber.
    await db.insert(skills).values({
      guildId: agentId,
      companyId,
      name: "claimed",
      body: "canonical version",
      provenance: "canonical",
    });

    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({ skills: [{ name: "claimed", body: "provisional attempt" }] }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.ingested).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.name).toBe("claimed");

    const persisted = await db.select().from(skills);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.body).toBe("canonical version");
    expect(persisted[0]?.provenance).toBe("canonical");
    await cleanup();
  });

  it("entries that are not objects or missing name/body are rejected; valid siblings persist", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [
          { name: "ok", body: "valid" },
          "string-entry",
          { name: "no-body" },
          { body: "no-name" },
          null,
          { name: "another-ok", body: "also valid" },
        ],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    expect(result.ingested).toHaveLength(2);
    expect(result.ingested.map((s) => s.name).sort()).toEqual(["another-ok", "ok"]);
    expect(result.rejected).toHaveLength(4);
    await cleanup();
  });

  it("defense in depth: kind != 'guild' returns the empty result and writes nothing", async () => {
    const { companyId, agentId } = await seed("agent");
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({ skills: [{ name: "should-not-write", body: "x" }] }),
    );

    const result = await ingestGuildLearnings({
      db,
      // Note: pass kind='agent' even though the row is also 'agent'
      // (defense in depth covers the case where a future caller
      // accidentally invokes ingest with a non-guild kind).
      agent: { id: agentId, companyId, kind: "agent", name: "regular-agent" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.fileMissing).toBe(true);
    expect(result.ingested).toEqual([]);
    expect(result.rejected).toEqual([]);

    const persisted = await db.select().from(skills);
    expect(persisted).toEqual([]);
    await cleanup();
  });

  // ─── Plan 3b: record-use via learnings.json `used[]` ──────────────────────

  /** Insert a canonical skill on the guild so we can record use against it. */
  async function seedSkill(
    companyId: string,
    guildId: string,
    name: string,
    body: string,
  ): Promise<string> {
    const inserted = await db
      .insert(skills)
      .values({ companyId, guildId, name, body, provenance: "canonical" })
      .returning({ id: skills.id });
    return inserted[0]!.id;
  }

  it("Plan 3b: used[] increments success_count when success=true", async () => {
    const { companyId, agentId } = await seed("guild");
    const skillId = await seedSkill(companyId, agentId, "redis-pool", "use pool size 20");
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [],
        used: [{ id: skillId, success: true }],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.recordedUse).toHaveLength(1);
    expect(result.recordedUse[0]).toMatchObject({
      id: skillId,
      name: "redis-pool",
      success: true,
    });
    expect(result.recordedUseRejected).toEqual([]);

    const persisted = await db.select().from(skills).where(eq(skills.id, skillId));
    expect(persisted[0]!.successCount).toBe(1);
    expect(persisted[0]!.failCount).toBe(0);
    await cleanup();
  });

  it("Plan 3b: used[] increments fail_count when success=false", async () => {
    const { companyId, agentId } = await seed("guild");
    const skillId = await seedSkill(companyId, agentId, "stale-advice", "this is misleading");
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [],
        used: [{ id: skillId, success: false }],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.recordedUse).toHaveLength(1);
    expect(result.recordedUse[0]!.success).toBe(false);

    const persisted = await db.select().from(skills).where(eq(skills.id, skillId));
    expect(persisted[0]!.successCount).toBe(0);
    expect(persisted[0]!.failCount).toBe(1);
    await cleanup();
  });

  it("Plan 3b: unknown skill id in used[] is rejected (caught service error)", async () => {
    const { companyId, agentId } = await seed("guild");
    const bogusId = randomUUID();
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [],
        used: [{ id: bogusId, success: true }],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.recordedUse).toEqual([]);
    expect(result.recordedUseRejected).toHaveLength(1);
    expect(result.recordedUseRejected[0]!.id).toBe(bogusId);
    expect(result.recordedUseRejected[0]!.reason).toMatch(/not found/i);
    await cleanup();
  });

  it("Plan 3b: missing id or non-boolean success rejected per entry; siblings unaffected", async () => {
    const { companyId, agentId } = await seed("guild");
    const goodId = await seedSkill(companyId, agentId, "good-one", "useful");
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [],
        used: [
          { success: true }, // missing id
          { id: goodId }, // missing success
          { id: 42, success: true }, // non-string id
          "not-an-object", // primitive
          null, // null entry
          { id: goodId, success: true }, // good one — survives
        ],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: randomUUID() },
      sandboxDir,
    });

    expect(result.recordedUse).toHaveLength(1);
    expect(result.recordedUse[0]!.id).toBe(goodId);
    expect(result.recordedUseRejected).toHaveLength(5);

    const persisted = await db.select().from(skills).where(eq(skills.id, goodId));
    expect(persisted[0]!.successCount).toBe(1);
    await cleanup();
  });

  it("Plan 3b: used[] coexists with skills[] in one learnings.json (mixed-batch happy path)", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    const existingId = await seedSkill(companyId, agentId, "existing-one", "old wisdom");
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [{ name: "newly-learned", body: "fresh insight from this run" }],
        used: [{ id: existingId, success: true }],
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    expect(result.ingested).toHaveLength(1);
    expect(result.ingested[0]!.name).toBe("newly-learned");
    expect(result.recordedUse).toHaveLength(1);
    expect(result.recordedUse[0]!.id).toBe(existingId);

    const allSkills = await db.select().from(skills);
    expect(allSkills).toHaveLength(2);
    const existing = allSkills.find((s) => s.id === existingId)!;
    expect(existing.successCount).toBe(1);
    await cleanup();
  });

  it("Plan 3b: absent used[] is treated as empty (legacy learnings.json shape still works)", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    const { sandboxDir, cleanup } = await withSandbox(
      // Legacy shape — only `skills`, no `used`.
      JSON.stringify({ skills: [{ name: "legacy-skill", body: "legacy body" }] }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    expect(result.ingested).toHaveLength(1);
    expect(result.recordedUse).toEqual([]);
    expect(result.recordedUseRejected).toEqual([]);
    await cleanup();
  });

  it("Plan 3b: non-array `used` value is treated as no used entries (lenient)", async () => {
    const { companyId, agentId } = await seed("guild");
    const runId = await seedRun(companyId, agentId);
    const { sandboxDir, cleanup } = await withSandbox(
      JSON.stringify({
        skills: [{ name: "lenient-shape", body: "valid" }],
        used: "not-an-array",
      }),
    );

    const result = await ingestGuildLearnings({
      db,
      agent: { id: agentId, companyId, kind: "guild", name: "eng-guild" },
      run: { id: runId },
      sandboxDir,
    });

    // `skills` still ingests; `used` malformed top-level is silently
    // dropped (no rejection rows — the entire array is absent).
    expect(result.ingested).toHaveLength(1);
    expect(result.recordedUse).toEqual([]);
    expect(result.recordedUseRejected).toEqual([]);
    await cleanup();
  });
});
