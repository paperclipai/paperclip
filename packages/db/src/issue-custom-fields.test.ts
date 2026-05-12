import { afterEach, describe, expect, it, beforeAll } from "vitest";
import postgres from "postgres";
import {
  applyPendingMigrations,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
let embeddedPostgresSupported = false;

beforeAll(async () => {
  const support = await getEmbeddedPostgresTestSupport();
  embeddedPostgresSupported = support.supported;
});

async function createTempDatabase() {
  if (!embeddedPostgresSupported) throw new Error("embedded postgres not supported on this platform");
  const db = await startEmbeddedPostgresTestDatabase("paperclip-icf-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

type Sql = ReturnType<typeof postgres>;

async function insertTestParents(sql: Sql) {
  const [company] = await sql`
    INSERT INTO companies (name) VALUES ('test-co') RETURNING id
  `;
  const [plugin] = await sql`
    INSERT INTO plugins (plugin_key, package_name, version, api_version, manifest_json)
    VALUES ('test.plugin', 'test-plugin', '1.0.0', 1, '{}')
    RETURNING id
  `;
  const [issue] = await sql`
    INSERT INTO issues (company_id, title, status, priority, origin_kind, request_depth)
    VALUES (${company.id}, 'Test issue', 'backlog', 'medium', 'manual', 0)
    RETURNING id
  `;
  return { companyId: company.id as string, issueId: issue.id as string, pluginId: plugin.id as string };
}

describe("issue_custom_fields migration", () => {
  it("creates the issue_custom_fields table with correct columns", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const tableExists = await sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = 'issue_custom_fields'
        ) as exists
      `;
      expect(tableExists[0].exists).toBe(true);

      const columns = await sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'issue_custom_fields'
        ORDER BY ordinal_position
      `;
      const colNames = columns.map((c: Record<string, unknown>) => c.column_name as string);
      expect(colNames).toContain("id");
      expect(colNames).toContain("company_id");
      expect(colNames).toContain("issue_id");
      expect(colNames).toContain("plugin_id");
      expect(colNames).toContain("field_key");
      expect(colNames).toContain("field_type");
      expect(colNames).toContain("field_label");
      expect(colNames).toContain("value_text");
      expect(colNames).toContain("value_number");
      expect(colNames).toContain("deleted_at");
      expect(colNames).toContain("deleted_by_plugin_id");
      expect(colNames).toContain("created_at");
      expect(colNames).toContain("updated_at");
    } finally {
      await sql.end();
    }
  });

  it("enforces field_key CHECK constraint: rejects keys with dots", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await expect(sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label)
        VALUES (
          gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          'bad.key', 'text', 'Label'
        )
      `).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("enforces field_key CHECK constraint: rejects keys starting with number", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await expect(sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label)
        VALUES (
          gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          '1bad', 'text', 'Label'
        )
      `).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("enforces field_type CHECK constraint: rejects unknown types", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      await expect(sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label)
        VALUES (
          gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          'mykey', 'jsonblob', 'Label'
        )
      `).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("enforces live-row unique index: rejects duplicate live field", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const { companyId, issueId, pluginId } = await insertTestParents(sql);

      await sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label, value_text)
        VALUES (${companyId}, ${issueId}, ${pluginId}, 'mykey', 'text', 'Label', 'v1')
      `;

      await expect(sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label, value_text)
        VALUES (${companyId}, ${issueId}, ${pluginId}, 'mykey', 'text', 'Label', 'v2')
      `).rejects.toThrow();
    } finally {
      await sql.end();
    }
  });

  it("allows re-insert after soft-delete (partial unique index respects deleted_at IS NULL)", async () => {
    const connectionString = await createTempDatabase();
    await applyPendingMigrations(connectionString);

    const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
    try {
      const { companyId, issueId, pluginId } = await insertTestParents(sql);

      await sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label, value_text)
        VALUES (${companyId}, ${issueId}, ${pluginId}, 'mykey', 'text', 'Label', 'v1')
      `;

      await sql`
        UPDATE issue_custom_fields
        SET deleted_at = now()
        WHERE company_id = ${companyId} AND issue_id = ${issueId}
          AND plugin_id = ${pluginId} AND field_key = 'mykey'
      `;

      await sql`
        INSERT INTO issue_custom_fields
          (company_id, issue_id, plugin_id, field_key, field_type, field_label, value_text)
        VALUES (${companyId}, ${issueId}, ${pluginId}, 'mykey', 'text', 'Label', 'v2')
      `;

      const liveRows = await sql`
        SELECT value_text FROM issue_custom_fields
        WHERE company_id = ${companyId} AND issue_id = ${issueId}
          AND plugin_id = ${pluginId} AND field_key = 'mykey'
          AND deleted_at IS NULL
      `;
      expect(liveRows).toHaveLength(1);
      expect(liveRows[0].value_text).toBe("v2");
    } finally {
      await sql.end();
    }
  });
});
