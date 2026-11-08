import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migrationFile = "0443_native_warm_follow_up_default.sql";
const actor = "migration:native-warm-follow-up-default";

(support.supported ? describe : describe.skip)("native warm follow-up default migration", () => {
  it("clears only the old per_turn default and records an auditable entry per agent", async () => {
    const database = await startEmbeddedPostgresTestDatabase("native-warm-follow-up-default-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const [company] = await sql`INSERT INTO companies (name, issue_prefix) VALUES ('Warm default', 'WD1') RETURNING id`;
      const candidates: Array<{ name: string; adapterType?: string; config: Record<string, string | number>; explicit?: boolean; migrates: boolean }> = [
        { name: "Codex default", config: { provider: "codex", model: "m", lifecycleMode: "per_turn", codexPermissionMode: "never" }, migrates: true },
        { name: "OpenCode default", config: { provider: "opencode", model: "m", lifecycleMode: "per_turn" }, migrates: true },
        { name: "Claude default", config: { provider: "acpx", acpxAgent: "claude", model: "m", lifecycleMode: "per_turn" }, migrates: true },
        // A user who switched to Turn by turn keeps it.
        { name: "Codex explicit", config: { provider: "codex", model: "m", lifecycleMode: "per_turn" }, explicit: true, migrates: false },
        { name: "Codex warm", config: { provider: "codex", model: "m", lifecycleMode: "warm", idleTimeoutMs: 900_000 }, migrates: false },
        { name: "Codex unset", config: { provider: "codex", model: "m" }, migrates: false },
        // Unmeasured harnesses keep their stored lifecycle.
        { name: "Grok", config: { provider: "acpx", acpxAgent: "grok", lifecycleMode: "per_turn" }, migrates: false },
        { name: "Pi", config: { provider: "acpx", acpxAgent: "pi", lifecycleMode: "per_turn" }, migrates: false },
        { name: "Cursor", config: { provider: "cursor_cloud", lifecycleMode: "per_turn" }, migrates: false },
        { name: "Legacy Codex", adapterType: "codex_local", config: { lifecycleMode: "per_turn" }, migrates: false },
      ];
      const ids = new Map<string, string>();
      for (const candidate of candidates) {
        const id = randomUUID();
        ids.set(candidate.name, id);
        await sql`INSERT INTO agents (id, company_id, name, adapter_type, adapter_config)
          VALUES (${id}, ${company!.id}, ${candidate.name}, ${candidate.adapterType ?? "paperclip_runner"}, ${sql.json(candidate.config)})`;
        if (candidate.explicit) {
          await sql`INSERT INTO agent_config_revisions (company_id, agent_id, changed_keys, before_config, after_config)
            VALUES (${company!.id}, ${id}, ${sql.json(["adapterConfig"])},
              ${sql.json({ adapterConfig: { ...candidate.config, lifecycleMode: "warm" } })},
              ${sql.json({ adapterConfig: candidate.config })})`;
        }
      }
      // A later unrelated edit that kept per_turn is not an explicit choice of it.
      await sql`INSERT INTO agent_config_revisions (company_id, agent_id, changed_keys, before_config, after_config)
        VALUES (${company!.id}, ${ids.get("Codex default")!}, ${sql.json(["adapterConfig"])},
          ${sql.json({ adapterConfig: { provider: "codex", model: "old", lifecycleMode: "per_turn" } })},
          ${sql.json({ adapterConfig: { provider: "codex", model: "m", lifecycleMode: "per_turn" } })})`;

      const content = await readFile(new URL(`./migrations/${migrationFile}`, import.meta.url), "utf8");
      const hash = createHash("sha256").update(content).digest("hex");
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await applyPendingMigrations(database.connectionString);

      const rows = await sql`SELECT id, adapter_config FROM agents WHERE company_id = ${company!.id}`;
      const configOf = (name: string) => rows.find(row => row.id === ids.get(name))!.adapter_config as Record<string, string | number>;
      for (const candidate of candidates) {
        if (candidate.migrates) {
          const { lifecycleMode: _cleared, ...rest } = candidate.config;
          expect(configOf(candidate.name)).toEqual(rest);
        } else {
          expect(configOf(candidate.name)).toEqual(candidate.config);
        }
      }
      const audit = await sql`SELECT entity_id, action, details FROM activity_log WHERE actor_id = ${actor} ORDER BY entity_id`;
      const migrated = candidates.filter(candidate => candidate.migrates).map(candidate => ids.get(candidate.name)!).sort();
      expect(audit.map(row => row.entity_id)).toEqual(migrated);
      expect(audit.every(row => row.action === "agent.updated" && row.details.source === "migration"
        && row.details.before.lifecycleMode === "per_turn" && row.details.after.lifecycleMode === null)).toBe(true);

      // Re-running finds nothing left to migrate and writes no duplicate audit rows.
      await sql.unsafe(content);
      expect(await sql`SELECT id FROM activity_log WHERE actor_id = ${actor}`).toHaveLength(migrated.length);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 120_000);
});
