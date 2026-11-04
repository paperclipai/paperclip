import { randomUUID } from "node:crypto";
import { applyPendingMigrations, closeRegisteredClients, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./embedded-postgres.js";

export const recoveryPostgresSupport = process.env.PAPERCLIP_TEST_DATABASE_URL
  ? { supported: true } : await getEmbeddedPostgresTestSupport();

/** Optional external host, always a fresh owned database; never reuse its data. */
export async function startRecoveryPostgres(prefix: string) {
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
