import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { agents, heartbeatRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import { authorizationService } from "./authorization.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_ID = "33333333-3333-4333-8333-333333333333";
const REAL_RUN_ID = "44444444-4444-4444-8444-444444444444";
// Synthetic, non-UUID run id carried by service/cron tokens (adapter_type
// "cron_service"), exactly as reported in QUA-3802.
const SYNTHETIC_RUN_ID = "cron-schema-drift-check-00000000-0000";

const AGENTS_TABLE = getTableName(agents);
const HEARTBEAT_RUNS_TABLE = getTableName(heartbeatRuns);

// Minimal recording stand-in for the drizzle query builder. It supports the
// `.select(...).from(table).where(...).then(cb)` chain used throughout
// authorization.ts and records which tables were actually queried, so we can
// assert that the heartbeat_runs lookup is skipped for non-UUID run ids.
function makeRecordingDb(responses: Record<string, unknown[]>): {
  db: Db;
  queriedTables: string[];
} {
  const queriedTables: string[] = [];

  function builder() {
    let table: string | null = null;
    const chain: Record<string, unknown> = {
      from(t: unknown) {
        table = getTableName(t as Parameters<typeof getTableName>[0]);
        queriedTables.push(table);
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (resolve: (rows: unknown[]) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(table ? responses[table] ?? [] : []).then(resolve, reject),
    };
    return chain;
  }

  const db = {
    select: () => builder(),
    execute: async () => [],
  } as unknown as Db;

  return { db, queriedTables };
}

function makeService(runId: string) {
  const { db, queriedTables } = makeRecordingDb({
    [AGENTS_TABLE]: [
      {
        id: AGENT_ID,
        companyId: COMPANY_ID,
        role: "engineer",
        status: "active",
        reportsTo: null,
        permissions: null,
      },
    ],
    // heartbeat_runs intentionally returns no rows; the control case still
    // proves the lookup is issued for a valid UUID.
    [HEARTBEAT_RUNS_TABLE]: [],
  });

  const service = authorizationService(db);
  const decide = () =>
    service.decide({
      actor: {
        type: "agent",
        agentId: AGENT_ID,
        companyId: COMPANY_ID,
        runId,
        source: "agent_key",
      },
      action: "issue:read",
      resource: { type: "issue", companyId: COMPANY_ID, issueId: ISSUE_ID, projectId: null },
    });

  return { decide, queriedTables };
}

describe("authorizationService loadRunPolicy run-id guard (QUA-3802)", () => {
  it("does not query heartbeat_runs for a synthetic (non-UUID) cron_service run id", async () => {
    const { decide, queriedTables } = makeService(SYNTHETIC_RUN_ID);

    // The bug surfaced as a 500: passing a non-UUID into a uuid column made
    // Postgres throw. With a real DB the recording stub cannot reproduce the
    // cast error, so we assert the stronger invariant: the lookup is never
    // issued at all for a non-UUID run id.
    const decision = await decide();

    expect(decision.allowed).toBe(true);
    expect(queriedTables).not.toContain(HEARTBEAT_RUNS_TABLE);
  });

  it("still queries heartbeat_runs for a well-formed UUID run id", async () => {
    const { decide, queriedTables } = makeService(REAL_RUN_ID);

    const decision = await decide();

    expect(decision.allowed).toBe(true);
    expect(queriedTables).toContain(HEARTBEAT_RUNS_TABLE);
  });
});
