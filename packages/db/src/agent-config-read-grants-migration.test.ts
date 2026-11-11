import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migrationFile = "0423_agent_config_read_defaults.sql";

(support.supported ? describe : describe.skip)("agent configuration read default migration", () => {
  it("adds only read access to existing standard agents and preserves restrictions and later revocation", async () => {
    const database = await startEmbeddedPostgresTestDatabase("agent-config-read-defaults-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Read defaults', 'RD1') RETURNING id`;
      const [otherCompany] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Other company', 'RD2') RETURNING id`;
      const candidates = [
        { name: "Legacy" },
        { name: "Paused", status: "paused", lifecycleState: "paused", lifecycleHolds: ["manual"], pauseReason: "manual" },
        { name: "Pausing", status: "paused", lifecycleState: "pausing", lifecycleHolds: ["manual"], pauseReason: "manual" },
        { name: "Resuming", status: "paused", lifecycleState: "resuming" },
        { name: "Configured" },
        { name: "Scoped configure" },
        { name: "Scoped suggest" },
        { name: "Scoped read" },
        { name: "Low trust", permissions: { trustPreset: "low_trust_review" } },
        { name: "Nested low trust", permissions: { authorizationPolicy: { trustPreset: "low_trust_review" } } },
        { name: "Review preset", permissions: { reviewPreset: { id: "low_trust_review" } } },
        { name: "Nested review preset", permissions: { authorizationPolicy: { reviewPreset: { id: "low_trust_review" } } } },
        { name: "Boundary", permissions: { authorizationPolicy: { trustBoundary: { mode: "low_trust_review" } } } },
        { name: "Unknown preset", permissions: { trustPreset: "unknown" } },
        { name: "Built in", metadata: { paperclipBuiltInAgent: { key: "summarizer", featureKeys: [] } } },
        { name: "Pending", status: "pending_approval" },
        { name: "Terminated", status: "terminated" },
        { name: "Setup", status: "paused", lifecycleState: "paused", lifecycleHolds: ["setup"], pauseReason: "setup" },
        { name: "Legacy setup", status: "paused", lifecycleState: "paused", pauseReason: "setup" },
        { name: "Inactive membership", membershipStatus: "inactive" },
        { name: "No membership", membershipStatus: "absent" },
        { name: "Wrong company membership", membershipStatus: "other_company" },
      ];
      const ids = new Map<string, string>();
      for (const candidate of candidates) {
        const id = randomUUID();
        ids.set(candidate.name, id);
        await sql`INSERT INTO agents (id, company_id, name, status, lifecycle_state, lifecycle_holds, pause_reason, permissions, metadata)
          VALUES (${id}, ${company!.id}, ${candidate.name}, ${candidate.status ?? "idle"},
            ${candidate.lifecycleState ?? "ready"}, ${sql.json(candidate.lifecycleHolds ?? [])}, ${candidate.pauseReason ?? null},
            ${sql.json(candidate.permissions ?? {})}, ${sql.json(candidate.metadata ?? {})})`;
        if (candidate.membershipStatus === "absent") continue;
        await sql`INSERT INTO company_memberships (company_id, principal_type, principal_id, status, membership_role)
          VALUES (${candidate.membershipStatus === "other_company" ? otherCompany!.id : company!.id}, 'agent', ${id},
            ${candidate.membershipStatus === "inactive" ? "inactive" : "active"}, 'member')`;
      }
      const scope = { agentIds: [ids.get("Legacy")!] };
      for (const [name, permissionKey, grantScope] of [
        ["Configured", "agents:configure", null],
        ["Scoped configure", "agents:configure", scope],
        ["Scoped suggest", "agents:suggest-changes", scope],
        ["Scoped read", "agents:read", scope],
      ] as const) {
        await sql`INSERT INTO principal_permission_grants (company_id, principal_type, principal_id, permission_key, scope)
          VALUES (${company!.id}, 'agent', ${ids.get(name)!}, ${permissionKey}, ${grantScope ? sql.json(grantScope) : null})`;
      }
      const before = await sql`SELECT principal_id, permission_key, scope FROM principal_permission_grants ORDER BY principal_id, permission_key`;
      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await applyPendingMigrations(database.connectionString);

      const after = await sql`SELECT principal_id, permission_key, scope FROM principal_permission_grants ORDER BY principal_id, permission_key`;
      const added = after.filter(row => !before.some(previous => previous.principal_id === row.principal_id && previous.permission_key === row.permission_key));
      expect(added).toEqual(expect.arrayContaining(["Legacy", "Paused", "Pausing", "Resuming", "Configured"].map(name => ({
        principal_id: ids.get(name), permission_key: "agents:read", scope: null,
      }))));
      expect(added).toHaveLength(5);
      expect(after.filter(row => row.permission_key !== "agents:read")).toEqual(before.filter(row => row.permission_key !== "agents:read"));
      expect(after.find(row => row.principal_id === ids.get("Scoped read"))).toMatchObject({ scope });
      const audit = await sql`SELECT entity_id, details FROM activity_log WHERE actor_id = 'migration:agent-config-read-defaults'`;
      expect(audit).toHaveLength(5);
      expect(audit.every(row => row.details.added.length === 1 && row.details.added[0] === "agents:read")).toBe(true);
      await sql.unsafe(content);
      expect(await sql`SELECT id FROM activity_log WHERE actor_id = 'migration:agent-config-read-defaults'`).toHaveLength(5);

      await sql`DELETE FROM principal_permission_grants WHERE principal_id = ${ids.get("Legacy")!} AND permission_key = 'agents:read'`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT id FROM principal_permission_grants WHERE principal_id = ${ids.get("Legacy")!}`).toHaveLength(0);
      expect(await sql`SELECT id FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`).toHaveLength(1);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 120_000);
});
