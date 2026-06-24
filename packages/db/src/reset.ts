import { applyPendingMigrations } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";
import postgres from "postgres";

async function main(): Promise<void> {
  console.log("Resetting database...");
  const resolved = await resolveMigrationConnection();

  console.log(`Connected to database via ${resolved.source}`);

  try {
    const sql = postgres(resolved.connectionString, { max: 1 });
    try {
      console.log("Dropping existing schemas (public, drizzle)...");
      await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE;");
      await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE;");
      await sql.unsafe("CREATE SCHEMA public;");
      console.log("Database schemas dropped and public schema recreated.");
    } finally {
      await sql.end();
    }

    console.log("Applying migrations...");
    await applyPendingMigrations(resolved.connectionString);
    console.log("Migrations applied successfully.");
  } finally {
    await resolved.stop();
  }
}

try {
  await main();
  console.log("Database reset complete successfully.");
  process.exit(0);
} catch (error) {
  console.error("Database reset failed:", error);
  process.exit(1);
}
