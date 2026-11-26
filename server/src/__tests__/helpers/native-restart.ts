import { describe } from "vitest";
import { recoveryPostgresSupport } from "./recovery-postgres.js";
export * from "./native-restart-fixture.js";

export const describeEmbeddedPostgres: typeof describe.skip = recoveryPostgresSupport.supported ? describe : describe.skip;
