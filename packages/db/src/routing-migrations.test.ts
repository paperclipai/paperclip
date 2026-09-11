import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping routing migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("task attempt routing migration", () => {
  it(
    "enforces tenant-safe profiles, cross-family decisions, lineage, and single writable claims",
    async () => {
      const database = await startEmbeddedPostgresTestDatabase("paperclip-routing-migrations-");
      cleanups.push(database.cleanup);
      const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
      const companyA = randomUUID();
      const companyB = randomUUID();
      const agentA = randomUUID();
      const agentB = randomUUID();
      const issueA = randomUUID();
      const profileA = randomUUID();
      const profileB = randomUUID();

      try {
        await sql`INSERT INTO "companies" ("id", "name", "issue_prefix") VALUES (${companyA}, 'A', 'RTA'), (${companyB}, 'B', 'RTB')`;
        await sql`INSERT INTO "agents" ("id", "company_id", "name", "role") VALUES (${agentA}, ${companyA}, 'a', 'engineer'), (${agentB}, ${companyB}, 'b', 'engineer')`;
        await sql`INSERT INTO "issues" ("id", "company_id", "title", "issue_number") VALUES (${issueA}, ${companyA}, 'routed', 1)`;

        // A profile may not bind an agent from another company.
        await expect(sql`
          INSERT INTO "execution_profiles" ("id", "company_id", "name", "provider_family", "agent_id", "model", "effort", "role_capabilities")
          VALUES (${profileA}, ${companyA}, 'cross', 'anthropic', ${agentB}, 'claude-fable-5-1', 'low', ARRAY['worker'])
        `).rejects.toThrow(/execution_profiles_agent_company_fk/);

        await sql`
          INSERT INTO "execution_profiles" ("id", "company_id", "name", "provider_family", "agent_id", "model", "effort", "role_capabilities")
          VALUES (${profileA}, ${companyA}, 'fable', 'anthropic', ${agentA}, 'claude-fable-5-1', 'low', ARRAY['worker', 'rescuer'])
        `;
        await sql`
          INSERT INTO "execution_profiles" ("id", "company_id", "name", "provider_family", "agent_id", "model", "effort", "role_capabilities")
          VALUES (${profileB}, ${companyB}, 'astra', 'openai', ${agentB}, 'gpt-6-astra', 'low', ARRAY['reviewer'])
        `;

        // Unknown role capabilities are rejected at the storage boundary.
        await expect(sql`
          UPDATE "execution_profiles" SET "role_capabilities" = ARRAY['owner'] WHERE "id" = ${profileA}
        `).rejects.toThrow(/execution_profiles_role_capabilities_check/);

        const decisionId = randomUUID();
        // A same-family reviewer can never be persisted, even by a raw write.
        await expect(sql`
          INSERT INTO "route_decisions" (
            "id", "company_id", "issue_id", "revision", "revision_kind", "policy_version", "task_class", "effective_task_class", "state",
            "worker_profile_id", "worker_agent_id", "worker_provider_family", "worker_model", "worker_effort",
            "reviewer_profile_id", "reviewer_agent_id", "reviewer_provider_family", "reviewer_model", "reviewer_effort",
            "max_attempts", "max_wall_clock_minutes", "created_by_type"
          ) VALUES (
            ${decisionId}, ${companyA}, ${issueA}, 1, 'initial', 'routing-policy/v1', 'feature_standard', 'feature_standard', 'routed',
            ${profileA}, ${agentA}, 'anthropic', 'claude-fable-5-1', 'low',
            ${profileA}, ${agentA}, 'anthropic', 'claude-fable-5-1', 'low',
            2, 180, 'system'
          )
        `).rejects.toThrow(/route_decisions_worker_state_check/);

        // A decision cannot reference a reviewer profile from another company.
        await expect(sql`
          INSERT INTO "route_decisions" (
            "id", "company_id", "issue_id", "revision", "revision_kind", "policy_version", "task_class", "effective_task_class", "state",
            "worker_profile_id", "worker_agent_id", "worker_provider_family", "worker_model", "worker_effort",
            "reviewer_profile_id", "reviewer_agent_id", "reviewer_provider_family", "reviewer_model", "reviewer_effort",
            "max_attempts", "max_wall_clock_minutes", "created_by_type"
          ) VALUES (
            ${decisionId}, ${companyA}, ${issueA}, 1, 'initial', 'routing-policy/v1', 'feature_standard', 'feature_standard', 'routed',
            ${profileA}, ${agentA}, 'anthropic', 'claude-fable-5-1', 'low',
            ${profileB}, ${agentB}, 'openai', 'gpt-6-astra', 'low',
            2, 180, 'system'
          )
        `).rejects.toThrow(/route_decisions_reviewer_profile_fk/);

        await sql`
          INSERT INTO "route_decisions" (
            "id", "company_id", "issue_id", "revision", "revision_kind", "policy_version", "task_class", "effective_task_class", "state",
            "worker_profile_id", "worker_agent_id", "worker_provider_family", "worker_model", "worker_effort",
            "max_attempts", "max_wall_clock_minutes", "created_by_type"
          ) VALUES (
            ${decisionId}, ${companyA}, ${issueA}, 1, 'initial', 'routing-policy/v1', 'feature_standard', 'feature_standard', 'reviewer-unavailable',
            ${profileA}, ${agentA}, 'anthropic', 'claude-fable-5-1', 'low',
            2, 180, 'system'
          )
        `;

        // Revision 2 must name its predecessor; revision 1 must not.
        await expect(sql`
          INSERT INTO "route_decisions" (
            "id", "company_id", "issue_id", "revision", "revision_kind", "policy_version", "task_class", "effective_task_class", "state",
            "max_attempts", "max_wall_clock_minutes", "created_by_type"
          ) VALUES (
            ${randomUUID()}, ${companyA}, ${issueA}, 2, 'escalation', 'routing-policy/v1', 'feature_standard', 'feature_standard', 'escalation-required',
            2, 180, 'system'
          )
        `).rejects.toThrow(/route_decisions_revision_check/);

        // Decisions are immutable in intent; the row has no updated_at column.
        const columns = await sql<{ column_name: string }[]>`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'route_decisions' AND column_name = 'updated_at'
        `;
        expect(columns).toEqual([]);

        await sql`
          INSERT INTO "route_pool_claims" ("company_id", "profile_id", "decision_id", "issue_id", "role")
          VALUES (${companyA}, ${profileA}, ${decisionId}, ${issueA}, 'worker')
        `;
        // A rescuer cannot hold a writable claim while a worker claim is active on the same issue.
        await expect(sql`
          INSERT INTO "route_pool_claims" ("company_id", "profile_id", "decision_id", "issue_id", "role")
          VALUES (${companyA}, ${profileA}, ${decisionId}, ${issueA}, 'rescuer')
        `).rejects.toThrow(/route_pool_claims_active_writable_issue_uq/);
        // Releasing requires a reason; the check keeps release evidence coherent.
        await expect(sql`
          UPDATE "route_pool_claims" SET "released_at" = now() WHERE "issue_id" = ${issueA}
        `).rejects.toThrow(/route_pool_claims_release_check/);
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
    120_000,
  );
});
