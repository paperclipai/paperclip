export function shouldBlockMigrationPreflight(input) {
  return input.disableMigrations === true && input.pendingMigrations.length > 0;
}
