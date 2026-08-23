/**
 * Cutover switch parsing for the deny-by-default cross-issue write grant
 * (FAI-10132). Dependency-free on purpose: `config.ts` validates it at startup
 * without pulling in the service layer, so an operator who mistypes the
 * timestamp learns at boot instead of silently keeping the broad writes.
 */

export const CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV = "CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT";

export class CrossIssueWriteGrantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossIssueWriteGrantConfigError";
  }
}

/**
 * Canonical ISO-8601 instant: date, `T`, time, explicit offset. The offset is
 * mandatory — `Z`, `+HH:MM` or `-HH:MM`. Fractional seconds are optional and
 * may be any length (`Date` truncates past milliseconds, which the round-trip
 * check below accounts for).
 */
const ISO_8601_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Absent means observe — that is the shipped default and a deliberate posture.
 * Present-but-unparseable means an operator *intended* a cutover and typed it
 * wrong; treating that as observe is a silent fail-open, so it is a hard error
 * (FAI-10134 blocking finding 4).
 *
 * `new Date(raw)` alone is not enough to decide "parseable". It accepts
 * `2026-02-30T00:00:00.000Z` and silently rolls it to March 2, and it reads an
 * offset-less `2026-09-01T00:00:00` in the *host's* local zone — so the same
 * env value arms enforcement at different instants on a UTC box and a
 * Europe/Bucharest box. Both mistakes defer or advance a security cutover
 * without telling anyone, so the shape is validated before the parse and the
 * calendar fields are validated after it.
 */
export function parseCrossIssueWriteGrantEnforceAt(raw: string | null | undefined): Date | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const shape = ISO_8601_INSTANT.exec(trimmed);
  if (!shape) throw invalidEnforceAt(trimmed, "it is not a canonical ISO-8601 instant with an explicit UTC offset");

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw invalidEnforceAt(trimmed, "it is not a valid timestamp");

  // Round-trip the calendar fields. `2026-02-30T00:00:00.000Z` matches the
  // shape above, and every route back through `Date` — including re-parsing a
  // rebuilt string — rolls it to March 2 rather than rejecting it. So the only
  // check that catches the rollover is reading the fields back off the parsed
  // instant and comparing them to what the operator typed. Reading them in the
  // *source* offset keeps `2026-02-30T00:00:00+02:00` a rollover rather than a
  // timezone shift.
  const [, year, month, day, hour, minute, second, , offset] = shape;
  const offsetMinutes =
    offset === "Z"
      ? 0
      : (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const wallClock = new Date(parsed.getTime() + offsetMinutes * 60_000);
  const sameField = [
    [wallClock.getUTCFullYear(), Number(year)],
    [wallClock.getUTCMonth() + 1, Number(month)],
    [wallClock.getUTCDate(), Number(day)],
    [wallClock.getUTCHours(), Number(hour)],
    [wallClock.getUTCMinutes(), Number(minute)],
    [wallClock.getUTCSeconds(), Number(second)],
  ].every(([actual, typed]) => actual === typed);
  if (!sameField) {
    throw invalidEnforceAt(trimmed, "it names a date or time that does not exist on the calendar");
  }

  return parsed;
}

function invalidEnforceAt(received: string, why: string) {
  return new CrossIssueWriteGrantConfigError(
    `${CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV} must be a canonical ISO-8601 timestamp with an ` +
      `explicit UTC offset (for example "2026-09-01T00:00:00.000Z" or "2026-09-01T02:00:00+02:00"); ` +
      `received ${JSON.stringify(received)} — ${why}. Unset the variable to stay in observe mode; a ` +
      `value this parser cannot pin to one instant is never treated as "not armed".`,
  );
}

/** Startup validation hook. Throws with the message above on an invalid value. */
export function assertCrossIssueWriteGrantEnforceAtConfig(env: NodeJS.ProcessEnv = process.env) {
  parseCrossIssueWriteGrantEnforceAt(env[CROSS_ISSUE_WRITE_GRANT_ENFORCE_AT_ENV]);
}
