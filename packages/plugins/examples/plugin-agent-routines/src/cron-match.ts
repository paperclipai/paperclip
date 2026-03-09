/**
 * Lightweight cron matching for the agent-routines plugin worker.
 *
 * Re-implements the core parsing logic from `server/src/services/cron.ts`
 * since plugin workers cannot import server modules. Only includes the
 * subset needed for matching — no nextCronTick or scheduling helpers.
 *
 * Supports standard 5-field cron expressions:
 *
 *   ┌────────────── minute (0–59)
 *   │ ┌──────────── hour   (0–23)
 *   │ │ ┌────────── day of month (1–31)
 *   │ │ │ ┌──────── month  (1–12)
 *   │ │ │ │ ┌────── day of week (0–6, Sun=0)
 *   │ │ │ │ │
 *   * * * * *
 *
 * Supported syntax per field: *, N, N-M, N/S, N-M/S, comma-separated lists.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

interface FieldSpec {
  min: number;
  max: number;
  name: string;
}

const FIELD_SPECS: FieldSpec[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day of month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day of week" },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function validateBounds(value: number, spec: FieldSpec): void {
  if (value < spec.min || value > spec.max) {
    throw new Error(
      `Value ${value} out of range [${spec.min}–${spec.max}] for cron ${spec.name} field`,
    );
  }
}

function parseField(token: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  const parts = token.split(",");

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "") {
      throw new Error(`Empty element in cron ${spec.name} field`);
    }

    // Step syntax: X/S
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx !== -1) {
      const base = trimmed.slice(0, slashIdx);
      const stepStr = trimmed.slice(slashIdx + 1);
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) {
        throw new Error(`Invalid step "${stepStr}" in cron ${spec.name} field`);
      }

      let rangeStart = spec.min;
      let rangeEnd = spec.max;

      if (base === "*") {
        // */S
      } else if (base.includes("-")) {
        const [a, b] = base.split("-").map((s) => parseInt(s, 10));
        if (isNaN(a!) || isNaN(b!)) {
          throw new Error(`Invalid range "${base}" in cron ${spec.name} field`);
        }
        rangeStart = a!;
        rangeEnd = b!;
      } else {
        const start = parseInt(base, 10);
        if (isNaN(start)) {
          throw new Error(`Invalid start "${base}" in cron ${spec.name} field`);
        }
        rangeStart = start;
      }

      validateBounds(rangeStart, spec);
      validateBounds(rangeEnd, spec);

      for (let i = rangeStart; i <= rangeEnd; i += step) {
        values.add(i);
      }
      continue;
    }

    // Range syntax: N-M
    if (trimmed.includes("-")) {
      const [aStr, bStr] = trimmed.split("-");
      const a = parseInt(aStr!, 10);
      const b = parseInt(bStr!, 10);
      if (isNaN(a) || isNaN(b)) {
        throw new Error(`Invalid range "${trimmed}" in cron ${spec.name} field`);
      }
      validateBounds(a, spec);
      validateBounds(b, spec);
      if (a > b) {
        throw new Error(
          `Invalid range ${a}-${b} in cron ${spec.name} field (start > end)`,
        );
      }
      for (let i = a; i <= b; i++) {
        values.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === "*") {
      for (let i = spec.min; i <= spec.max; i++) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const val = parseInt(trimmed, 10);
    if (isNaN(val)) {
      throw new Error(`Invalid value "${trimmed}" in cron ${spec.name} field`);
    }
    validateBounds(val, spec);
    values.add(val);
  }

  if (values.size === 0) {
    throw new Error(`Empty result for cron ${spec.name} field`);
  }

  return [...values].sort((a, b) => a - b);
}

function parseCron(expression: string): ParsedCron {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new Error("Cron expression must not be empty");
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields, got ${tokens.length}: "${trimmed}"`,
    );
  }

  return {
    minutes: parseField(tokens[0]!, FIELD_SPECS[0]!),
    hours: parseField(tokens[1]!, FIELD_SPECS[1]!),
    daysOfMonth: parseField(tokens[2]!, FIELD_SPECS[2]!),
    months: parseField(tokens[3]!, FIELD_SPECS[3]!),
    daysOfWeek: parseField(tokens[4]!, FIELD_SPECS[4]!),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a cron expression matches the given date at minute-level
 * granularity (UTC). Returns `true` if the current minute matches.
 */
export function shouldFireAt(cronExpression: string, date: Date): boolean {
  const parsed = parseCron(cronExpression);
  return (
    parsed.minutes.includes(date.getUTCMinutes()) &&
    parsed.hours.includes(date.getUTCHours()) &&
    parsed.daysOfMonth.includes(date.getUTCDate()) &&
    parsed.months.includes(date.getUTCMonth() + 1) &&
    parsed.daysOfWeek.includes(date.getUTCDay())
  );
}

/**
 * Validate a cron expression string. Returns `null` if valid, or an error
 * message string if invalid.
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
