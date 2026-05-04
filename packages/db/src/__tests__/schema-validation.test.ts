import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function createTempDatabase(): Promise<string> {
  const db = await startEmbeddedPostgresTestDatabase("paperclip-rt2-schema-validation-");
  cleanups.push(db.cleanup);
  return db.connectionString;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres schema validation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("RT2 schema validation", () => {
  describe("rt2_v33_domain_events", () => {
    it(
      "creates the domain events table with correct columns",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const columns = await sql.unsafe<Array<{
            column_name: string;
            data_type: string;
          }>>(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'rt2_v33_domain_events' ORDER BY column_name`,
          );

          const columnsMap = Object.fromEntries(
            columns.map((row) => [row.column_name, row.data_type]),
          );

          expect(columnsMap).toHaveProperty("id");
          expect(columnsMap).toHaveProperty("company_id");
          expect(columnsMap).toHaveProperty("event_type");
          expect(columnsMap).toHaveProperty("event_version");
          expect(columnsMap).toHaveProperty("actor_type");
          expect(columnsMap).toHaveProperty("actor_id");
          expect(columnsMap).toHaveProperty("entity_type");
          expect(columnsMap).toHaveProperty("entity_id");
          expect(columnsMap).toHaveProperty("command_id");
          expect(columnsMap).toHaveProperty("correlation_id");
          expect(columnsMap).toHaveProperty("causation_id");
          expect(columnsMap).toHaveProperty("idempotency_key");
          expect(columnsMap).toHaveProperty("payload");
          expect(columnsMap).toHaveProperty("metadata");
          expect(columnsMap).toHaveProperty("occurred_at");
          expect(columnsMap).toHaveProperty("created_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has actor_type check constraint with correct values",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ consrc: string }>>(
            `SELECT consrc FROM pg_constraint WHERE conname = 'rt2_v33_domain_events_actor_type_check'`,
          );

          expect(result).toBeDefined();
          expect(result.consrc).toContain("user");
          expect(result.consrc).toContain("agent");
          expect(result.consrc).toContain("system");
          expect(result.consrc).toContain("runtime");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has company_idempotency unique index with partial condition",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'rt2_v33_domain_events_company_idempotency_uq'`,
          );

          expect(result).toBeDefined();
          expect(result.indexdef).toContain("company_id");
          expect(result.indexdef).toContain("idempotency_key");
          expect(result.indexdef).toContain("WHERE");
          expect(result.indexdef).toContain("idempotency_key");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has company_occurred index",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'rt2_v33_domain_events_company_occurred_idx'`,
          );

          expect(result).toBeDefined();
          expect(result.indexdef).toContain("company_id");
          expect(result.indexdef).toContain("occurred_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has company_type_occurred index",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'rt2_v33_domain_events_company_type_occurred_idx'`,
          );

          expect(result).toBeDefined();
          expect(result.indexdef).toContain("company_id");
          expect(result.indexdef).toContain("event_type");
          expect(result.indexdef).toContain("occurred_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );
  });

  describe("rt2_v33_execution_attempts", () => {
    it(
      "creates the execution attempts table with correct columns",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const columns = await sql.unsafe<Array<{ column_name: string; data_type: string }>>(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'rt2_v33_execution_attempts' ORDER BY column_name`,
          );

          const columnsMap = Object.fromEntries(
            columns.map((row) => [row.column_name, row.data_type]),
          );

          expect(columnsMap).toHaveProperty("id");
          expect(columnsMap).toHaveProperty("company_id");
          expect(columnsMap).toHaveProperty("task_issue_id");
          expect(columnsMap).toHaveProperty("state");
          expect(columnsMap).toHaveProperty("executor_type");
          expect(columnsMap).toHaveProperty("executor_id");
          expect(columnsMap).toHaveProperty("queued_by_user_id");
          expect(columnsMap).toHaveProperty("queued_at");
          expect(columnsMap).toHaveProperty("claimed_at");
          expect(columnsMap).toHaveProperty("started_at");
          expect(columnsMap).toHaveProperty("completed_at");
          expect(columnsMap).toHaveProperty("failure_reason");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has state check constraint with all 8 values",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ consrc: string }>>(
            `SELECT consrc FROM pg_constraint WHERE conname = 'rt2_v33_execution_attempts_state_check'`,
          );

          expect(result).toBeDefined();
          expect(result.consrc).toContain("queued");
          expect(result.consrc).toContain("dispatched");
          expect(result.consrc).toContain("claimed");
          expect(result.consrc).toContain("running");
          expect(result.consrc).toContain("completed");
          expect(result.consrc).toContain("failed");
          expect(result.consrc).toContain("cancelled");
          expect(result.consrc).toContain("blocked");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has executor_type check constraint for nullable user/jarvis/runtime",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ consrc: string }>>(
            `SELECT consrc FROM pg_constraint WHERE conname = 'rt2_v33_execution_attempts_executor_type_check'`,
          );

          expect(result).toBeDefined();
          // Should allow null OR one of user/jarvis/runtime
          expect(result.consrc).toContain("user");
          expect(result.consrc).toContain("jarvis");
          expect(result.consrc).toContain("runtime");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has task_updated index",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'rt2_v33_execution_attempts_task_updated_idx'`,
          );

          expect(result).toBeDefined();
          expect(result.indexdef).toContain("task_issue_id");
          expect(result.indexdef).toContain("updated_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has company_state index",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'rt2_v33_execution_attempts_company_state_idx'`,
          );

          expect(result).toBeDefined();
          expect(result.indexdef).toContain("company_id");
          expect(result.indexdef).toContain("state");
          expect(result.indexdef).toContain("updated_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );
  });

  describe("rt2_v33_work_entities", () => {
    it(
      "creates the work entities table with correct columns",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const columns = await sql.unsafe<Array<{ column_name: string; data_type: string }>>(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'rt2_v33_work_entities' ORDER BY column_name`,
          );

          const columnsMap = Object.fromEntries(
            columns.map((row) => [row.column_name, row.data_type]),
          );

          expect(columnsMap).toHaveProperty("id");
          expect(columnsMap).toHaveProperty("company_id");
          expect(columnsMap).toHaveProperty("task_issue_id");
          expect(columnsMap).toHaveProperty("deliverable_work_product_id");
          expect(columnsMap).toHaveProperty("state");
          expect(columnsMap).toHaveProperty("archived_at");
          expect(columnsMap).toHaveProperty("legacy_source_id");
          expect(columnsMap).toHaveProperty("created_at");
          expect(columnsMap).toHaveProperty("updated_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has state check constraint for draft/active/completed/cancelled",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ consrc: string }>>(
            `SELECT consrc FROM pg_constraint WHERE conname = 'rt2_v33_work_entities_state_check'`,
          );

          expect(result).toBeDefined();
          expect(result.consrc).toContain("draft");
          expect(result.consrc).toContain("active");
          expect(result.consrc).toContain("completed");
          expect(result.consrc).toContain("cancelled");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has company_task_delivery unique index with partial condition",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ indexdef: string }>>(
            `SELECT indexdef FROM pg_indexes WHERE indexname = 'rt2_v33_work_entities_company_task_delivery_uq'`,
          );

          expect(result).toBeDefined();
          expect(result.indexdef).toContain("company_id");
          expect(result.indexdef).toContain("task_issue_id");
          expect(result.indexdef).toContain("deliverable_work_product_id");
          expect(result.indexdef).toContain("WHERE");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );
  });

  describe("rt2_v33_work_entities_archive", () => {
    it(
      "creates the archive table with migration columns",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const columns = await sql.unsafe<Array<{ column_name: string }>>(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'rt2_v33_work_entities_archive' ORDER BY column_name`,
          );

          const columnNames = columns.map((row) => row.column_name);

          expect(columnNames).toContain("id");
          expect(columnNames).toContain("company_id");
          expect(columnNames).toContain("task_issue_id");
          expect(columnNames).toContain("deliverable_work_product_id");
          expect(columnNames).toContain("state");
          expect(columnNames).toContain("migration_batch_id");
          expect(columnNames).toContain("migrated_at");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );
  });

  describe("rt2_v33_work_projector_state", () => {
    it(
      "creates the projector state table with correct columns",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const columns = await sql.unsafe<Array<{ column_name: string; data_type: string }>>(
            `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'rt2_v33_work_projector_state' ORDER BY column_name`,
          );

          const columnsMap = Object.fromEntries(
            columns.map((row) => [row.column_name, row.data_type]),
          );

          expect(columnsMap).toHaveProperty("projector_name");
          expect(columnsMap).toHaveProperty("status");
          expect(columnsMap).toHaveProperty("last_event_id");
          expect(columnsMap).toHaveProperty("last_processed_at");
          expect(columnsMap).toHaveProperty("failure_count");
          expect(columnsMap).toHaveProperty("last_error");
          expect(columnsMap).toHaveProperty("metadata");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );

    it(
      "has status check constraint for idle/running/failed",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ consrc: string }>>(
            `SELECT consrc FROM pg_constraint WHERE conname = 'rt2_v33_work_projector_state_status_check'`,
          );

          expect(result).toBeDefined();
          expect(result.consrc).toContain("idle");
          expect(result.consrc).toContain("running");
          expect(result.consrc).toContain("failed");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );
  });

  describe("rt2_v33_projector_state", () => {
    it(
      "has status check constraint for idle/running/failed",
      async () => {
        const connectionString = await createTempDatabase();
        const sql = postgres(connectionString, { max: 1, onnotice: () => {} });

        try {
          const [result] = await sql.unsafe<Array<{ consrc: string }>>(
            `SELECT consrc FROM pg_constraint WHERE conname = 'rt2_v33_projector_state_status_check'`,
          );

          expect(result).toBeDefined();
          expect(result.consrc).toContain("idle");
          expect(result.consrc).toContain("running");
          expect(result.consrc).toContain("failed");
        } finally {
          await sql.end();
        }
      },
      20_000,
    );
  });
});
