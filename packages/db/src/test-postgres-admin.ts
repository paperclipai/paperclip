import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { applyPendingMigrations, closeRegisteredClients } from "./client.js";

export function testPostgresAdminUrl(): string | undefined {
  const value = process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL?.trim();
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("PAPERCLIP_TEST_POSTGRES_ADMIN_URL must be a PostgreSQL URL");
  }
  return value;
}

export async function checkTestPostgresAdmin(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 5, onnotice() {} });
  try { await sql`SELECT 1`; }
  finally { await sql.end({ timeout: 1 }); }
}

export async function startTestPostgresDatabase(adminUrl: string): Promise<{
  connectionString: string;
  cleanup(): Promise<void>;
}> {
  const name = `paperclip_test_${randomUUID().replaceAll("-", "")}`;
  const setting = process.env.PAPERCLIP_TEST_POSTGRES_TEMPLATE;
  const template = setting === "0" ? undefined : setting;
  if (template && !/^paperclip_test_template_[a-f0-9]+$/.test(template)) {
    throw new Error("Invalid disposable test template name");
  }
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 5, onnotice() {} });
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const connectionString = url.toString();
  let cleaning: Promise<void> | null = null;
  const cleanup = () => cleaning ??= (async () => {
    try {
      await closeRegisteredClients(connectionString, { scope: "database" });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally { await admin.end({ timeout: 1 }); }
  })();
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ""}`);
    await applyPendingMigrations(connectionString);
    return { connectionString, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
