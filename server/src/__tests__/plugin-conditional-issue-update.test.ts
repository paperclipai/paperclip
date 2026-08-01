import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issues,
  pluginDatabaseNamespaces,
  plugins,
  versionedIssuePatch,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginConditionalIssueUpdateService } from "../services/plugin-conditional-issue-update.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping conditional issue update tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeEmbeddedPostgres("plugin conditional issue update", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let pluginId!: string;
  let namespace!: string;
  let companyId!: string;
  let issueId!: string;

  const pluginKey = "paperclip.conditional-test";
  const matchingFence = {
    table: "mutation_lanes",
    lane: { lane_key: "phase-a2" },
    expected: { fence_token: "fence-1", generation: 7 },
  } as const;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-conditional-issue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    pluginId = randomUUID();
    companyId = randomUUID();
    namespace = `plugin_conditional_${pluginId.replaceAll("-", "").slice(0, 12)}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Conditional test",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: pluginKey,
      version: "1.0.0",
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "1.0.0",
        displayName: "Conditional Test",
        description: "Tests fenced issue mutation",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["issues.update", "database.namespace.read", "database.namespace.write"],
        entrypoints: { worker: "./worker.js" },
      },
      status: "installed",
    });
    await db.insert(pluginDatabaseNamespaces).values({
      pluginId,
      pluginKey,
      namespaceName: namespace,
      namespaceMode: "schema",
      status: "active",
    });
    await db.execute(sql.raw(`
      CREATE SCHEMA "${namespace}";
      CREATE TABLE "${namespace}"."mutation_lanes" (
        lane_key text PRIMARY KEY,
        fence_token text NOT NULL,
        generation integer NOT NULL
      );
      INSERT INTO "${namespace}"."mutation_lanes"
        (lane_key, fence_token, generation)
      VALUES ('phase-a2', 'fence-1', 7);
    `));
    issueId = await db.insert(issues).values({
      companyId,
      title: "Original",
      description: "baseline",
    }).returning({ id: issues.id }).then((rows) => rows[0]!.id);
  });

  afterEach(async () => {
    await db.execute(sql.raw("DROP TRIGGER IF EXISTS fail_conditional_activity ON activity_log"));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS fail_conditional_activity()"));
    if (namespace) {
      await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`));
    }
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(pluginDatabaseNamespaces);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function service() {
    return pluginConditionalIssueUpdateService(db, pluginId, pluginKey);
  }

  async function issueSnapshot() {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  async function activityCount() {
    return db.select().from(activityLog).where(and(
      eq(activityLog.entityId, issueId),
      eq(activityLog.action, "issue.conditional_updated"),
    )).then((rows) => rows.length);
  }

  it("applies once, increments version, and records one activity", async () => {
    const result = await service().update({
      issueId,
      companyId,
      patch: { title: "Applied" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    });

    expect(result).toMatchObject({ applied: true, issue: { title: "Applied", version: 2 } });
    expect((await issueSnapshot()).version).toBe(2);
    const activities = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(activities).toEqual([
      expect.objectContaining({
        actorType: "plugin",
        actorId: pluginId,
        action: "issue.conditional_updated",
      }),
    ]);
  });

  it("returns explicit stale fence and version outcomes without writes", async () => {
    const staleFence = await service().update({
      issueId,
      companyId,
      patch: { title: "Must not apply" },
      expectedVersion: 1,
      namespaceFence: {
        ...matchingFence,
        expected: { fence_token: "stale", generation: 7 },
      },
    });
    expect(staleFence).toEqual({ applied: false, reason: "fence_mismatch" });

    const staleVersion = await service().update({
      issueId,
      companyId,
      patch: { title: "Must not apply either" },
      expectedVersion: 0,
      namespaceFence: matchingFence,
    });
    expect(staleVersion).toEqual({ applied: false, reason: "issue_version_mismatch" });
    expect(await issueSnapshot()).toMatchObject({ title: "Original", version: 1 });
    expect(await activityCount()).toBe(0);
  });

  it("fails closed for tenant and namespace escape attempts", async () => {
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other tenant",
      issuePrefix: `O${otherCompanyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    const tenantResult = await service().update({
      issueId,
      companyId: otherCompanyId,
      patch: { title: "Escaped" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    });
    expect(tenantResult).toEqual({ applied: false, reason: "not_found" });

    await expect(service().update({
      issueId,
      companyId,
      patch: { title: "Escaped" },
      expectedVersion: 1,
      namespaceFence: { ...matchingFence, table: "public.issues" },
    })).rejects.toThrow("Invalid namespace fence table");
    expect(await issueSnapshot()).toMatchObject({ title: "Original", version: 1 });
    expect(await activityCount()).toBe(0);
  });

  it("does not lose a concurrent writer update", async () => {
    const writerLocked = deferred();
    const releaseWriter = deferred();
    const writer = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM ${issues} WHERE ${issues.id} = ${issueId} FOR UPDATE`);
      writerLocked.resolve();
      await releaseWriter.promise;
      await tx.update(issues)
        .set(versionedIssuePatch({ description: "writer won" }))
        .where(eq(issues.id, issueId));
    });
    await writerLocked.promise;

    const conditional = service().update({
      issueId,
      companyId,
      patch: { title: "Conditional" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    });
    releaseWriter.resolve();
    await writer;

    expect(await conditional).toEqual({ applied: false, reason: "issue_version_mismatch" });
    expect(await issueSnapshot()).toMatchObject({
      title: "Original",
      description: "writer won",
      version: 2,
    });
    expect(await activityCount()).toBe(0);
  });

  it("serializes containment-first as a fence loss", async () => {
    await db.execute(sql.raw(`
      UPDATE "${namespace}"."mutation_lanes"
      SET fence_token = 'fence-2', generation = 8
      WHERE lane_key = 'phase-a2'
    `));
    const result = await service().update({
      issueId,
      companyId,
      patch: { title: "Must not apply" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    });
    expect(result).toEqual({ applied: false, reason: "fence_mismatch" });
    expect(await issueSnapshot()).toMatchObject({ title: "Original", version: 1 });
  });

  it("serializes mutation-first before later containment", async () => {
    const result = await service().update({
      issueId,
      companyId,
      patch: { title: "Mutation won" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    });
    expect(result).toMatchObject({ applied: true, issue: { version: 2 } });
    await db.execute(sql.raw(`
      UPDATE "${namespace}"."mutation_lanes"
      SET fence_token = 'fence-2', generation = 8
      WHERE lane_key = 'phase-a2'
    `));
    expect(await issueSnapshot()).toMatchObject({ title: "Mutation won", version: 2 });
    expect(await activityCount()).toBe(1);
  });

  it("rejects provenance spoofing before any write", async () => {
    await expect(service().update({
      issueId,
      companyId,
      patch: { title: "Spoofed", actorAgentId: randomUUID() } as never,
      expectedVersion: 1,
      namespaceFence: matchingFence,
    })).rejects.toThrow("forbidden field: actorAgentId");
    expect(await issueSnapshot()).toMatchObject({ title: "Original", version: 1 });
    expect(await activityCount()).toBe(0);
  });

  it("rolls back the issue when activity persistence fails", async () => {
    await db.execute(sql.raw(`
      CREATE FUNCTION fail_conditional_activity() RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'issue.conditional_updated' THEN
          RAISE EXCEPTION 'activity insert failed';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_conditional_activity
      BEFORE INSERT ON activity_log
      FOR EACH ROW EXECUTE FUNCTION fail_conditional_activity();
    `));

    await expect(service().update({
      issueId,
      companyId,
      patch: { title: "Ambiguous" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    })).rejects.toThrow("Failed query: insert into \"activity_log\"");
    expect(await issueSnapshot()).toMatchObject({ title: "Original", version: 1 });
    expect(await activityCount()).toBe(0);
  });

  it("is retry-safe after a successful application", async () => {
    const input = {
      issueId,
      companyId,
      patch: { title: "Exactly once" },
      expectedVersion: 1,
      namespaceFence: matchingFence,
    };
    expect(await service().update(input)).toMatchObject({ applied: true });
    expect(await service().update(input)).toEqual({
      applied: false,
      reason: "issue_version_mismatch",
    });
    expect(await issueSnapshot()).toMatchObject({ title: "Exactly once", version: 2 });
    expect(await activityCount()).toBe(1);
  });
});
