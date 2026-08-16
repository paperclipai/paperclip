import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb } from "./client.js";
import {
  agentApiKeys,
  agents,
  activityLog,
  companies,
  companyWorkProjectionCredentials,
  companyWorkProjectionIssueHeads,
  companyWorkProjectionRevisions,
  companyWorkProjectionSourceEvents,
  companyWorkProjectionSourceWitnesses,
  companyWorkProjectionVerifications,
  companyMemberships,
  issueWorkProjectionVersions,
  issues,
  projects,
} from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_WORK_PROJECTION_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping company work projection migration test: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
}

const DROP_0218_SQL = `
  DROP TRIGGER IF EXISTS issues_work_projection_capture ON public.issues;
  DROP TRIGGER IF EXISTS companies_work_projection_initialize ON public.companies;
  DROP TRIGGER IF EXISTS projects_work_projection_reference_capture ON public.projects;
  DROP TRIGGER IF EXISTS agents_work_projection_reference_capture ON public.agents;
  DROP TRIGGER IF EXISTS company_memberships_work_projection_reference_capture ON public.company_memberships;
  DROP FUNCTION IF EXISTS public.capture_issue_work_projection_change();
  DROP FUNCTION IF EXISTS public.initialize_company_work_projection_revision();
  DROP FUNCTION IF EXISTS public.capture_project_work_projection_reference_change();
  DROP FUNCTION IF EXISTS public.capture_agent_work_projection_reference_change();
  DROP FUNCTION IF EXISTS public.capture_membership_work_projection_reference_change();
  DROP FUNCTION IF EXISTS public.append_current_issue_work_projection_version(public.issues);
  DROP FUNCTION IF EXISTS public.append_issue_work_projection_version(
    uuid, uuid, boolean, text, uuid, uuid, text, text, text,
    timestamp with time zone, timestamp with time zone, timestamp with time zone,
    timestamp with time zone, timestamp with time zone
  );
  DROP FUNCTION IF EXISTS public.company_work_projection_issue_is_visible(
    timestamp with time zone, text, text
  );
  DROP FUNCTION IF EXISTS public.company_work_projection_project_reference_is_valid(uuid, uuid);
  DROP FUNCTION IF EXISTS public.company_work_projection_agent_reference_is_valid(uuid, uuid);
  DROP FUNCTION IF EXISTS public.company_work_projection_user_reference_is_valid(uuid, text);
  DROP FUNCTION IF EXISTS public.invalidate_company_work_projection_verification(uuid);
  DROP FUNCTION IF EXISTS public.verify_company_work_projection_recovery(uuid);
  DROP TABLE IF EXISTS public.company_work_projection_credentials;
  DROP TABLE IF EXISTS public.company_work_projection_verifications;
  DROP TABLE IF EXISTS public.company_work_projection_source_events;
  DROP TABLE IF EXISTS public.company_work_projection_issue_heads;
  DROP TABLE IF EXISTS public.issue_work_projection_versions;
  DROP TABLE IF EXISTS public.company_work_projection_source_witnesses;
  DROP TABLE IF EXISTS public.company_work_projection_revisions;
  DROP FUNCTION IF EXISTS public.reject_company_work_projection_append_only_mutation();
`;

async function waitForBlockedSourceWriters(connectionString: string) {
  const inspector = postgres(connectionString, { max: 1, onnotice: () => undefined });
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const rows = await inspector<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_locks AS locks
        JOIN pg_class AS relations ON relations.oid = locks.relation
        JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
        WHERE namespaces.nspname = 'public'
          AND relations.relname IN ('issues', 'projects', 'agents', 'company_memberships')
          AND locks.granted = false
      `;
      if ((rows[0]?.waiting ?? 0) >= 7) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("concurrent projection-source writers did not block on migration lock");
  } finally {
    await inspector.end();
  }
}

describePostgres("0218 company work projection migration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString!: string;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      connectionString = externalDatabaseUrl;
      await applyPendingMigrations(connectionString);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-projection-migration-");
      connectionString = tempDb.connectionString;
    }
    db = createDb(connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("locks writers across backfill, captures all concurrent mutations, seeds counters, and isolates credentials", async () => {
    await db.execute(sql.raw(DROP_0218_SQL));

    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const updateIssueId = randomUUID();
    const deleteIssueId = randomUUID();
    const moveIssueId = randomUUID();
    const insertIssueId = randomUUID();
    const pluginIssueId = randomUUID();
    const referenceIssueId = randomUUID();
    const userReferenceIssueId = randomUUID();
    const projectId = randomUUID();
    const userId = "synthetic-migration-user";
    const agentId = randomUUID();
    const legacyToken = `pcp_${"d".repeat(48)}`;

    await db.insert(companies).values([
      { id: sourceCompanyId, name: "Synthetic migration source", issuePrefix: `S${sourceCompanyId.slice(0, 6)}` },
      { id: targetCompanyId, name: "Synthetic migration target", issuePrefix: `T${targetCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId: sourceCompanyId,
      name: "Synthetic legacy reader",
      role: "integration",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId: sourceCompanyId,
      name: "Synthetic migration project",
    });
    await db.insert(companyMemberships).values({
      companyId: sourceCompanyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    await db.execute(sql`
      INSERT INTO public.agent_api_keys (
        id, agent_id, company_id, name, key_hash, scope_config
      ) VALUES (
        ${randomUUID()}::uuid,
        ${agentId}::uuid,
        ${sourceCompanyId}::uuid,
        'unreleased projection residue',
        ${createHash("sha256").update(legacyToken).digest("hex")},
        '{"kind":"company_work_projection_read"}'::jsonb
      )
    `);
    await db.insert(issues).values([
      {
        id: updateIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic update",
        identifier: "MIG-UPDATE",
        status: "todo",
        priority: "low",
        updatedAt: new Date("2026-08-14T20:00:00Z"),
      },
      {
        id: deleteIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic delete",
        identifier: "MIG-DELETE",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-08-14T20:01:00Z"),
      },
      {
        id: moveIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic move",
        identifier: "MIG-MOVE",
        status: "todo",
        priority: "high",
        updatedAt: new Date("2026-08-14T20:02:00Z"),
      },
      {
        id: pluginIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic plugin operation",
        identifier: "MIG-PLUGIN",
        status: "todo",
        priority: "low",
        originKind: "plugin:synthetic:operation",
        updatedAt: new Date("2026-08-14T20:03:00Z"),
      },
      {
        id: referenceIssueId,
        companyId: sourceCompanyId,
        projectId,
        title: "Synthetic reference lifecycle",
        identifier: "MIG-REFERENCE",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        updatedAt: new Date("2026-08-14T20:04:00Z"),
      },
      {
        id: userReferenceIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic membership lifecycle",
        identifier: "MIG-MEMBER",
        status: "todo",
        priority: "low",
        assigneeUserId: userId,
        updatedAt: new Date("2026-08-14T20:05:00Z"),
      },
    ]);

    const migration = await readFile(
      new URL("./migrations/0218_company_work_projection.sql", import.meta.url),
      "utf8",
    );
    const statements = migration
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean);
    const migrationConnection = postgres(connectionString, { max: 1, onnotice: () => undefined });
    const writers = postgres(connectionString, { max: 7, onnotice: () => undefined });
    try {
      await migrationConnection.unsafe("BEGIN");
      await migrationConnection.unsafe(statements[0]);

      const concurrentWrites = Promise.all([
        writers`
          INSERT INTO public.issues (id, company_id, title, identifier, status, priority)
          VALUES (${insertIssueId}::uuid, ${sourceCompanyId}::uuid, 'Concurrent insert', 'MIG-INSERT', 'todo', 'critical')
        `,
        writers`
          UPDATE public.issues SET status = 'in_progress', updated_at = now()
          WHERE id = ${updateIssueId}::uuid
        `,
        writers`DELETE FROM public.issues WHERE id = ${deleteIssueId}::uuid`,
        writers`
          UPDATE public.issues SET company_id = ${targetCompanyId}::uuid, updated_at = now()
          WHERE id = ${moveIssueId}::uuid
        `,
        writers`
          UPDATE public.projects SET archived_at = now(), updated_at = now()
          WHERE id = ${projectId}::uuid
        `,
        writers`
          UPDATE public.agents SET status = 'pending_approval', updated_at = now()
          WHERE id = ${agentId}::uuid
        `,
        writers`
          UPDATE public.company_memberships SET status = 'archived', updated_at = now()
          WHERE company_id = ${sourceCompanyId}::uuid
            AND principal_type = 'user'
            AND principal_id = ${userId}
        `,
      ]);

      await waitForBlockedSourceWriters(connectionString);
      for (const statement of statements.slice(1)) {
        await migrationConnection.unsafe(statement);
      }
      await migrationConnection.unsafe("COMMIT");
      await concurrentWrites;
    } catch (error) {
      await migrationConnection.unsafe("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await writers.end();
      await migrationConnection.end();
    }

    const legacyRows = await db.select().from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, createHash("sha256").update(legacyToken).digest("hex")));
    expect(legacyRows[0]?.revokedAt).toBeInstanceOf(Date);

    const sourceHistory = await db.select().from(issueWorkProjectionVersions)
      .where(eq(issueWorkProjectionVersions.companyId, sourceCompanyId));
    const targetHistory = await db.select().from(issueWorkProjectionVersions)
      .where(eq(issueWorkProjectionVersions.companyId, targetCompanyId));
    for (const history of [sourceHistory, targetHistory]) {
      expect(history.map((row) => row.revision).sort((left, right) => Number(left - right))).toEqual(
        Array.from({ length: history.length }, (_, index) => BigInt(index + 1)),
      );
    }
    expect(sourceHistory.some((row) => row.issueId === insertIssueId && !row.deleted)).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === updateIssueId && row.status === "in_progress")).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === deleteIssueId && row.deleted)).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === moveIssueId && row.deleted)).toBe(true);
    expect(targetHistory.some((row) => row.issueId === moveIssueId && !row.deleted)).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === pluginIssueId)).toBe(false);
    const latestReference = sourceHistory
      .filter((row) => row.issueId === referenceIssueId)
      .sort((left, right) => Number(right.revision - left.revision))[0];
    expect(latestReference).toMatchObject({
      projectReferenceValid: false,
      assigneeAgentReferenceValid: false,
    });
    const latestUserReference = sourceHistory
      .filter((row) => row.issueId === userReferenceIssueId)
      .sort((left, right) => Number(right.revision - left.revision))[0];
    expect(latestUserReference?.assigneeUserReferenceValid).toBe(false);

    for (const [companyId, history] of [
      [sourceCompanyId, sourceHistory],
      [targetCompanyId, targetHistory],
    ] as const) {
      const counter = await db.select().from(companyWorkProjectionRevisions)
        .where(eq(companyWorkProjectionRevisions.companyId, companyId));
      expect(counter[0]?.currentRevision).toBe(BigInt(history.length));
      const witness = await db.select().from(companyWorkProjectionSourceWitnesses)
        .where(eq(companyWorkProjectionSourceWitnesses.companyId, companyId));
      expect(witness[0]?.currentRevision).toBe(counter[0]?.currentRevision);
      expect(witness[0]?.currentIntegrityToken).toBe(counter[0]?.currentIntegrityToken);
      expect(await db.select().from(companyWorkProjectionSourceEvents)
        .where(eq(companyWorkProjectionSourceEvents.companyId, companyId))).toHaveLength(history.length);
      expect(await db.select().from(companyWorkProjectionIssueHeads)
        .where(eq(companyWorkProjectionIssueHeads.companyId, companyId))).toHaveLength(
          new Set(history.map((row) => row.issueId)).size,
        );
      expect(await db.select().from(companyWorkProjectionVerifications)
        .where(eq(companyWorkProjectionVerifications.companyId, companyId))).toMatchObject([
          {
            companyId,
            verifiedRevision: BigInt(history.length),
            verifiedHistoryCount: BigInt(history.length),
            verifiedEventCount: BigInt(history.length),
          },
        ]);
    }

    const futureCompanyId = randomUUID();
    await db.insert(companies).values({
      id: futureCompanyId,
      name: "Synthetic future company",
      issuePrefix: `F${futureCompanyId.slice(0, 6)}`,
    });
    expect(await db.select().from(companyWorkProjectionRevisions)
      .where(eq(companyWorkProjectionRevisions.companyId, futureCompanyId))).toMatchObject([
      { companyId: futureCompanyId, currentRevision: 0n },
    ]);
    const futureCounter = await db.select().from(companyWorkProjectionRevisions)
      .where(eq(companyWorkProjectionRevisions.companyId, futureCompanyId))
      .then((rows) => rows[0]);
    expect(await db.select().from(companyWorkProjectionSourceWitnesses)
      .where(eq(companyWorkProjectionSourceWitnesses.companyId, futureCompanyId))).toMatchObject([
      {
        companyId: futureCompanyId,
        currentRevision: 0n,
        currentIntegrityToken: futureCounter.currentIntegrityToken,
      },
    ]);
    expect(await db.select().from(companyWorkProjectionVerifications)
      .where(eq(companyWorkProjectionVerifications.companyId, futureCompanyId))).toMatchObject([
      { companyId: futureCompanyId, verifiedRevision: 0n, verifiedHistoryCount: 0n },
    ]);

    const projectionToken = `pcwp_v1_${"e".repeat(48)}`;
    const projectionHash = createHash("sha256").update(projectionToken).digest("hex");
    const credentialId = randomUUID();
    const audit = await db.insert(activityLog).values({
      companyId: sourceCompanyId,
      actorType: "user",
      actorId: "synthetic-owner",
      action: "company_work_projection.credential_created",
      entityType: "company_work_projection_credential",
      entityId: credentialId,
    }).returning({ id: activityLog.id }).then((rows) => rows[0]);
    await db.insert(companyWorkProjectionCredentials).values({
      id: credentialId,
      companyId: sourceCompanyId,
      name: "Synthetic dedicated reader",
      keyHash: projectionHash,
      tokenVersion: 1,
      creationActivityId: audit.id,
    });
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.keyHash, projectionHash))).toEqual([]);
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.keyHash, projectionHash))).toHaveLength(1);
  }, 30_000);

  it("bounds first, middle, and final page plans independently of 100k accumulated revisions", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic scale company",
      issuePrefix: `Q${companyId.slice(0, 6)}`,
    });
    await db.execute(sql`
      WITH generated AS (
        SELECT
          ${companyId}::uuid AS company_id,
          ('00000000-0000-0000-0000-' || lpad((((sequence - 1) % 10000) + 1)::text, 12, '0'))::uuid AS issue_id,
          sequence::bigint AS revision,
          gen_random_uuid() AS integrity_token
        FROM generate_series(1, 100000) AS sequence
      )
      INSERT INTO public.issue_work_projection_versions (
        company_id, issue_id, revision, deleted, identifier,
        project_reference_valid, assignee_agent_reference_valid,
        assignee_user_reference_valid, status, priority, created_at, updated_at,
        integrity_token, recorded_at
      )
      SELECT
        company_id, issue_id, revision, false, 'SCALE-' || revision::text,
        true, true, true, 'todo', 'medium', now(), now(), integrity_token, now()
      FROM generated
    `);
    await db.execute(sql`
      INSERT INTO public.company_work_projection_source_events (
        company_id, revision, integrity_token, recorded_at
      )
      SELECT company_id, revision, integrity_token, recorded_at
      FROM public.issue_work_projection_versions
      WHERE company_id = ${companyId}::uuid
    `);
    await db.execute(sql`
      INSERT INTO public.company_work_projection_issue_heads (
        company_id, issue_id, first_revision, current_revision, updated_at
      )
      SELECT company_id, issue_id, min(revision), max(revision), now()
      FROM public.issue_work_projection_versions
      WHERE company_id = ${companyId}::uuid
      GROUP BY company_id, issue_id
    `);
    await db.execute(sql`
      WITH latest AS (
        SELECT revision, integrity_token
        FROM public.issue_work_projection_versions
        WHERE company_id = ${companyId}::uuid
        ORDER BY revision DESC
        LIMIT 1
      )
      UPDATE public.company_work_projection_revisions
      SET current_revision = latest.revision,
          current_integrity_token = latest.integrity_token,
          updated_at = now()
      FROM latest
      WHERE company_id = ${companyId}::uuid
    `);
    await db.execute(sql`
      WITH latest AS (
        SELECT revision, integrity_token
        FROM public.issue_work_projection_versions
        WHERE company_id = ${companyId}::uuid
        ORDER BY revision DESC
        LIMIT 1
      )
      UPDATE public.company_work_projection_source_witnesses
      SET current_revision = latest.revision,
          current_integrity_token = latest.integrity_token,
          updated_at = now()
      FROM latest
      WHERE company_id = ${companyId}::uuid
    `);
    const verified = await db.execute(sql<{ verified: boolean }>`
      SELECT public.verify_company_work_projection_recovery(${companyId}::uuid) AS verified
    `);
    expect(Array.from(verified)[0]?.verified).toBe(true);
    await db.execute(sql.raw(
      "ANALYZE public.company_work_projection_issue_heads, public.issue_work_projection_versions",
    ));

    const client = postgres(connectionString, { max: 1, onnotice: () => undefined });
    try {
      for (const afterRevision of [0, 5000, 9900]) {
        const explain = await client.unsafe(`
          EXPLAIN (ANALYZE, FORMAT JSON)
          SELECT head.issue_id, history.revision, history.deleted
          FROM public.company_work_projection_issue_heads AS head
          LEFT JOIN LATERAL (
            SELECT version.revision, version.deleted
            FROM public.issue_work_projection_versions AS version
            WHERE version.company_id = head.company_id
              AND version.issue_id = head.issue_id
              AND version.revision <= 100000
            ORDER BY version.revision DESC
            LIMIT 1
          ) AS history ON true
          WHERE head.company_id = '${companyId}'::uuid
            AND head.first_revision <= 100000
            AND (head.first_revision, head.issue_id)
              > (${afterRevision}, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY head.first_revision, head.issue_id
          LIMIT 101
        `);
        const plan = explain[0]?.["QUERY PLAN"]?.[0];
        const serializedPlan = JSON.stringify(plan);
        expect(serializedPlan).toContain("company_work_projection_issue_heads_first_revision_idx");
        expect(serializedPlan).toContain("issue_work_projection_versions_company_issue_revision_idx");
        expect(serializedPlan).not.toContain('"Relation Name":"issue_work_projection_versions","Alias":"version","Scan Direction":"Forward","Actual Rows":100000');
        expect(plan?.["Execution Time"]).toBeLessThan(250);

        const nodes: Array<Record<string, unknown>> = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) visit(child);
        };
        visit(plan.Plan as Record<string, unknown>);
        const materializationNodes = nodes.filter((node) => (
          node["Relation Name"] === "company_work_projection_issue_heads"
          || node["Relation Name"] === "issue_work_projection_versions"
        ));
        expect(materializationNodes.length).toBeGreaterThanOrEqual(2);
        for (const node of materializationNodes) {
          expect(Number(node["Actual Rows"] ?? 0), serializedPlan).toBeLessThanOrEqual(101);
        }
      }
    } finally {
      await client.end();
    }
  }, 45_000);
});
