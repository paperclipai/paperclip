export type StartupMigrationMode = "embedded" | "external";

type StartupMigrationDecisionInput = {
  mode: StartupMigrationMode;
  clusterAlreadyInitialized: boolean;
  databaseStatus: "created" | "exists";
};

export function shouldAutoApplyStartupMigrations(input: StartupMigrationDecisionInput): boolean {
  if (input.mode === "embedded") {
    return true;
  }

  return !input.clusterAlreadyInitialized || input.databaseStatus === "created";
}
