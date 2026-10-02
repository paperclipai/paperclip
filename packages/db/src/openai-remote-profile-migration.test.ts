import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("OpenAI remote profile migration", () => {
  it("preserves AWS profiles and enforces the OpenAI credential binding", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-openai-profile-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const migration = await readFile(new URL("./migrations/0294_sleepy_viper.sql", import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement);
      }
      const companyId = randomUUID();
      const secretId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Managed profiles', 'MPR')`;
      await sql`INSERT INTO company_secrets (id, company_id, key, name)
        VALUES (${secretId}, ${companyId}, 'openai', 'OpenAI')`;
      const insertProfile = (service: string, credential: string | null) => sql`
        INSERT INTO remote_agent_profiles (company_id, profile_key, display_name, service, credential_secret_id)
        VALUES (${companyId}, ${randomUUID()}, 'Profile', ${service}, ${credential})
        RETURNING service, credential_secret_id
      `;

      expect(await insertProfile("aws_bedrock_agentcore_harness", null)).toMatchObject([
        { service: "aws_bedrock_agentcore_harness", credential_secret_id: null },
      ]);
      expect(await insertProfile("openai_agents_api", secretId)).toMatchObject([
        { service: "openai_agents_api", credential_secret_id: secretId },
      ]);
      await expect(insertProfile("openai_agents_api", null)).rejects.toMatchObject({ code: "23514" });
      await expect(insertProfile("aws_bedrock_agentcore_harness", secretId)).rejects.toMatchObject({ code: "23514" });
      await expect(insertProfile("unknown_service", null)).rejects.toMatchObject({ code: "23514" });
      await expect(insertProfile("openai_agents_api", randomUUID())).rejects.toMatchObject({ code: "23503" });
      await expect(sql`DELETE FROM company_secrets WHERE id = ${secretId}`).rejects.toMatchObject({ code: "23001" });
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 30_000);
});
