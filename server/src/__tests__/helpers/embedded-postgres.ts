import { randomUUID } from "node:crypto";
import {
  applyPendingMigrations,
  createDb,
  getEmbeddedPostgresTestSupport as embeddedSupport,
  startEmbeddedPostgresTestDatabase as startEmbedded,
  type EmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestSupport,
} from "@paperclipai/db";

export type { EmbeddedPostgresTestDatabase, EmbeddedPostgresTestSupport };

export async function getEmbeddedPostgresTestSupport(): Promise<EmbeddedPostgresTestSupport> {
  return process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL ? { supported: true } : embeddedSupport();
}

export async function startEmbeddedPostgresTestDatabase(prefix: string): Promise<EmbeddedPostgresTestDatabase> {
  const adminUrl = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL;
  if (!adminUrl) return startEmbedded(prefix);
  const name = `paperclip_test_${randomUUID().replaceAll("-", "")}`;
  const template = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
  if (template && !/^paperclip_test_template_[a-f0-9]+$/.test(template)) throw new Error("Invalid disposable test template name");
  const admin = createDb(adminUrl, { maxConnections: 1 });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const cleanup = async () => {
    try { await admin.$client.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
    finally { await admin.$client.end({ timeout: 1 }); }
  };
  try {
    await admin.$client.unsafe(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
    if (!template) await applyPendingMigrations(url.toString());
    return { connectionString: url.toString(), cleanup };
  } catch (error) { await cleanup(); throw error; }
}
