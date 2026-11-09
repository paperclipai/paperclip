import { getRecoveryPostgresSupport } from "./recovery-postgres-fixture.js";
export { getRecoveryPostgresSupport, startRecoveryPostgres } from "./recovery-postgres-fixture.js";

export const recoveryPostgresSupport = await getRecoveryPostgresSupport();
