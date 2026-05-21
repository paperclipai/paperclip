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
});
