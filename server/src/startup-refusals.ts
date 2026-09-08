/**
 * Deliberate boot refusals and whether they should page Sentry.
 *
 * Some startup preconditions the server must not repair itself: an
 * unmigrated schema when auto-apply is off (the operator's migration
 * runner owns schema), or an unmet database contract for authenticated
 * public deployments. The server logs the refusal and exits nonzero so
 * whatever supervises the deployment can act.
 *
 * In supervised managed-cloud deployments (`PAPERCLIP_CLOUD_API_ORIGIN`
 * set), two of these refusals are a routine provisioning phase rather
 * than an incident: a freshly created stack's app container boots
 * before the harness has migrated the empty database or finished
 * applying its committed configuration, crash-loops briefly, and is
 * restarted by the harness once the precondition holds. Reporting every
 * such boot to Sentry buries real errors under hundreds of expected
 * events per fleet build batch, so the crash handler skips the capture
 * for exactly this class — the refusal still logs and still exits
 * nonzero. Everywhere else (self-hosted, local dev) reporting is
 * unchanged.
 */

export type StartupRefusalKind =
  | "schema-not-yet-migrated"
  | "database-contract-unmet";

/**
 * A boot refusal whose remedy belongs to the deployment's supervisor.
 * Only refusals that are *expected transients* under managed-cloud
 * provisioning use this class; refusals that always indicate operator
 * error (schema drift, a malformed DATABASE_URL) stay plain `Error`s.
 */
export class StartupRefusalError extends Error {
  readonly kind: StartupRefusalKind;

  constructor(kind: StartupRefusalKind, message: string) {
    super(message);
    this.name = "StartupRefusalError";
    this.kind = kind;
  }
}

/**
 * Chooses the error class for a pending-migrations refusal. A database
 * with zero applied migrations AND zero tables is not stale — it has
 * never been migrated at all, which under a supervisor means "not yet"
 * rather than "drifted". Any applied history, or any pre-existing
 * tables beside an empty or wiped migration journal, makes pending
 * migrations a drift signal that must keep reporting.
 */
export function migrationRefusalError(
  state: { appliedMigrations: string[]; tableCount: number },
  message: string,
): Error {
  const neverMigrated = state.appliedMigrations.length === 0 && state.tableCount === 0;
  return neverMigrated
    ? new StartupRefusalError("schema-not-yet-migrated", message)
    : new Error(message);
}

/**
 * Whether a startup failure should be captured to Sentry. Everything
 * reports except a supervised-transient refusal in a managed-cloud
 * deployment.
 */
export function shouldReportStartupFailure(
  error: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!(error instanceof StartupRefusalError)) return true;
  const cloudOrigin = env.PAPERCLIP_CLOUD_API_ORIGIN?.trim();
  return !cloudOrigin;
}
