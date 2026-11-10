import { resolveExternalTestDatabaseUrl } from "./external-test-database.js";
import { randomUUID } from "node:crypto";
import { applyPendingMigrations, closeRegisteredClients, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestSupport } from "./embedded-postgres.js";

type RecoveryPostgresOptions = { dedicatedDatabaseUrl?: string };

export async function getRecoveryPostgresSupport(options: RecoveryPostgresOptions = {}): Promise<EmbeddedPostgresTestSupport> {
  if (options.dedicatedDatabaseUrl !== undefined) {
    if (!resolveExternalTestDatabaseUrl("dedicated recovery database", options.dedicatedDatabaseUrl)) {
      throw new Error("Dedicated recovery database URL is required");
    }
    return { supported: true };
  }
  return process.env.PAPERCLIP_TEST_DATABASE_URL ? { supported: true } : getEmbeddedPostgresTestSupport();
}

export async function startRecoveryPostgres(prefix: string, options: RecoveryPostgresOptions = {}) {
  const dedicated = options.dedicatedDatabaseUrl;
  if (dedicated !== undefined) {
    const connectionString = resolveExternalTestDatabaseUrl("dedicated recovery database", dedicated);
    if (!connectionString) throw new Error("Dedicated recovery database URL is required");
    await applyPendingMigrations(connectionString);
    return { connectionString, cleanup: () => closeRegisteredClients(connectionString, { scope: "database" }) };
  }
  const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
  if (!external) return startEmbeddedPostgresTestDatabase(prefix);
  const databaseName = `recovery_${randomUUID().replaceAll("-", "")}`;
  const admin = createDb(external);
  try { await admin.$client.unsafe(`create database "${databaseName}"`); }
  finally { await admin.$client.end(); }
  const url = new URL(external); url.pathname = `/${databaseName}`;
  const connectionString = url.toString();
  const cleanup = async () => {
    await closeRegisteredClients(connectionString, { scope: "database" });
    const owner = createDb(external);
    try { await owner.$client.unsafe(`drop database "${databaseName}"`); }
    finally { await owner.$client.end(); }
  };
  try { await applyPendingMigrations(connectionString); }
  catch (error) { await cleanup().catch(() => undefined); throw error; }
  return { connectionString, cleanup };
}
