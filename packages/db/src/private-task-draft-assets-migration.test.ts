import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import postgres from "postgres";
import { expect, it } from "vitest";
import { applyPendingMigrations } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const itEmbeddedPostgres = embeddedPostgresSupport.supported ? it : it.skip;

itEmbeddedPostgres("backfills owned draft images without attaching another uploader's images", async () => {
  const database = await startEmbeddedPostgresTestDatabase("paperclip-draft-privacy-");
  const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
  try {
    const migration = await fs.readFile(new URL("./migrations/0292_private_task_draft_assets.sql", import.meta.url), "utf8");
    const hash = createHash("sha256").update(migration).digest("hex");
    const company = randomUUID(), task = randomUUID(), owned = randomUUID(), foreign = randomUUID();
    await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${company}, 'Draft privacy', 'DRAFT')`;
    for (const [id, owner] of [[owned, 'owner'], [foreign, 'someone-else']]) {
      await sql`INSERT INTO assets (id, company_id, provider, object_key, content_type, byte_size, sha256, created_by_user_id)
        VALUES (${id}, ${company}, 'local_disk', ${`${company}/assets/issues/drafts/${id}`}, 'image/png', 1, 'test', ${owner})`;
    }
    await sql`INSERT INTO issues (id, company_id, title, description, visibility, created_by_user_id)
      VALUES (${task}, ${company}, 'Private task', ${`![owned](/api/assets/${owned}/content) ![foreign](/api/assets/${foreign}/content)`}, 'private', 'owner')`;
    for (let run = 0; run < 2; run += 1) {
      await sql`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
      await applyPendingMigrations(database.connectionString);
      expect(await sql`SELECT issue_id, asset_id FROM issue_attachments WHERE company_id = ${company}`)
        .toEqual([{ issue_id: task, asset_id: owned }]);
    }
  } finally {
    await sql.end();
    await database.cleanup();
  }
}, 60_000);
