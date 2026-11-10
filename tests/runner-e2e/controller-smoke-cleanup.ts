import { setTimeout as delay } from "node:timers/promises";

export async function cleanupControllerSmokeDatabase(
  database: { cleanup(): Promise<void> },
  ownedProcessId: number | null | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  await database.cleanup();
  // An external fixture owns a database, not its shared Postgres process. Its
  // cleanup awaits DROP DATABASE. Embedded cleanup can return before exit.
  if (ownedProcessId === null) return;
  if (typeof ownedProcessId !== "number" || !Number.isSafeInteger(ownedProcessId) || ownedProcessId <= 0) {
    throw new Error("owned_postgres_identity_unavailable");
  }
  const deadline = performance.now() + timeoutMs;
  while (true) {
    try { process.kill(ownedProcessId, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    if (performance.now() >= deadline) throw new Error("owned_postgres_exit_unconfirmed");
    await delay(Math.min(25, deadline - performance.now()));
  }
}
