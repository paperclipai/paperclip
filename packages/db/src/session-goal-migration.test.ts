import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migration = readFileSync(new URL("./migrations/0248_small_manta.sql", import.meta.url), "utf8");

(support.supported ? describe : describe.skip)("session goal migration", () => {
  it("preserves preview goals, tombstone revisions, and pending actions on replay", async () => {
    const database = await startEmbeddedPostgresTestDatabase("goal-migration-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID(), clearedId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Goal migration', 'GMG')`;
      await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}, ${companyId}, 'Goal agent', 'engineer', 'paperclip_runner')`;
      const goal = { objective: "Keep the preview objective", status: "paused" };
      await sql`INSERT INTO agent_task_sessions (id, company_id, agent_id, adapter_type, task_key, goal_json, goal_status, goal_revision)
        VALUES (${sessionId}, ${companyId}, ${agentId}, 'paperclip_runner', 'active', ${sql.json(goal)}, 'paused', 7),
               (${clearedId}, ${companyId}, ${agentId}, 'paperclip_runner', 'cleared', NULL, NULL, 9)`;
      await sql`INSERT INTO agent_session_goal_actions (company_id, session_id, request_id, action, payload_json)
        VALUES (${companyId}, ${sessionId}, 'resume-once', 'resume', '{}')`;
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await sql.unsafe(statement);
        }
      }
      const sessions = await sql`SELECT task_key, goal_json, goal_status, goal_revision FROM agent_task_sessions
        WHERE company_id = ${companyId} ORDER BY task_key`;
      expect([...sessions]).toEqual([
        { task_key: "active", goal_json: goal, goal_status: "paused", goal_revision: 7 },
        { task_key: "cleared", goal_json: null, goal_status: null, goal_revision: 9 },
      ]);
      const actions = await sql`SELECT request_id, action, status FROM agent_session_goal_actions WHERE company_id = ${companyId}`;
      expect([...actions]).toEqual([{ request_id: "resume-once", action: "resume", status: "pending" }]);
      await expect(sql`INSERT INTO agent_session_goal_actions (company_id, session_id, request_id, action, payload_json)
        VALUES (${companyId}, ${sessionId}, 'resume-once', 'resume', '{}')`).rejects.toMatchObject({ code: "23505" });
      await sql`DELETE FROM agent_task_sessions WHERE company_id = ${companyId}`;
      expect(await sql`SELECT id FROM agent_session_goal_actions WHERE company_id = ${companyId}`).toHaveLength(0);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 30_000);
});
