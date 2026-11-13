/// <reference types="vite/client" />

/**
 * Declared build-time inputs for the explorer, supplied by
 * `scripts/capability-explorer-fixtures.mjs`. The explorer is an example consumer
 * and reaches package or spec files only through these entry points.
 */
declare module "virtual:capability-scenario-manifest" {
  /** The checked-in Capability traceability derivative, verbatim. */
  const manifestSource: string;
  export default manifestSource;
}

declare module "virtual:capability-eval-report" {
  /** Capability's parity report, or `null` when it has not been generated. */
  const evalReport: unknown;
  export default evalReport;
}
