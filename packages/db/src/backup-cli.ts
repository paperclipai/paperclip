import { backupDatabase, restoreDatabase, listBackups } from "./backup.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

const command = process.argv[2];

async function main(): Promise<void> {
  const resolved = await resolveMigrationConnection();
  try {
    switch (command) {
      case "backup": {
        const path = await backupDatabase(resolved.connectionString);
        if (path) console.log(`Backup complete: ${path}`);
        break;
      }
      case "restore": {
        const backupPath = process.argv[3];
        if (!backupPath) {
          console.error("Usage: pnpm db:restore <backup-file.sql>");
          const backups = await listBackups();
          if (backups.length > 0) {
            console.log("\nAvailable backups:");
            backups.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
          }
          process.exit(1);
        }
        await restoreDatabase(resolved.connectionString, backupPath);
        console.log("Restore complete.");
        break;
      }
      case "list": {
        const backups = await listBackups();
        if (backups.length === 0) {
          console.log("No backups found.");
        } else {
          console.log("Available backups:");
          backups.forEach((b) => console.log(`  ${b}`));
        }
        break;
      }
      default:
        console.log("Usage: pnpm db:backup | pnpm db:restore <file> | pnpm db:backup:list");
        process.exit(1);
    }
  } finally {
    await resolved.stop();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error("Backup command failed:", error);
  process.exit(1);
}
