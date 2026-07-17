export const DEFAULT_EXTERNAL_OPERATION_CONTROLLER_MAX_ATTEMPTS = 10;
export const MAX_EXTERNAL_OPERATION_CONTROLLER_MAX_ATTEMPTS = 30;
export const MAX_EXTERNAL_OPERATION_CONTROLLER_ATTEMPT_MINUTES = 60;
export const MAX_EXTERNAL_OPERATION_CONTROLLER_ATTEMPT_SCHEDULE_LENGTH = 3;

export const EXTERNAL_OPERATION_TERMINAL_STATES = [
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
] as const;

const TERMINAL_STATE_SET = new Set<string>(EXTERNAL_OPERATION_TERMINAL_STATES);

export interface ExternalOperationProgressPathInput {
  state: string;
  terminalAt?: Date | string | null;
  nextCheckAt?: Date | string | null;
  timeoutAt?: Date | string | null;
  metadata?: unknown;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readDateMs(value: unknown) {
  if (!(typeof value === "string" || value instanceof Date)) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function normalizeExternalOperationControllerMaxAttempts(value: unknown) {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_EXTERNAL_OPERATION_CONTROLLER_MAX_ATTEMPTS;
  return Math.max(
    1,
    Math.min(MAX_EXTERNAL_OPERATION_CONTROLLER_MAX_ATTEMPTS, Math.floor(numeric)),
  );
}

export function readExternalOperationControllerAttemptState(metadata: unknown) {
  const controller = readRecord(readRecord(metadata).paperclipController);
  const attemptCount = Math.max(
    0,
    Math.floor(
      typeof controller.attemptCount === "number" && Number.isFinite(controller.attemptCount)
        ? controller.attemptCount
        : 0,
    ),
  );
  return {
    attemptCount,
    maxAttempts: normalizeExternalOperationControllerMaxAttempts(controller.maxAttempts),
  };
}

export function readExternalOperationControllerAttemptMinutes(metadata: unknown) {
  const controller = readRecord(readRecord(metadata).paperclipController);
  const raw = controller.attemptMinutes;
  if (raw === undefined) return null;
  if (
    !Array.isArray(raw)
    || raw.length === 0
    || raw.length > MAX_EXTERNAL_OPERATION_CONTROLLER_ATTEMPT_SCHEDULE_LENGTH
  ) {
    return null;
  }
  const minutes: number[] = [];
  for (const value of raw) {
    if (
      typeof value !== "number"
      || !Number.isInteger(value)
      || value < 1
      || value > MAX_EXTERNAL_OPERATION_CONTROLLER_ATTEMPT_MINUTES
      || (minutes.length > 0 && value <= minutes[minutes.length - 1]!)
    ) {
      return null;
    }
    minutes.push(value);
  }
  return minutes;
}

/**
 * Returns true only while Paperclip's controller owns a bounded, actionable
 * external wait. An unbounded, exhausted, terminal, or internally inconsistent
 * row must never certify an issue as healthy forever.
 */
export function isBoundedExternalOperationProgressPath(
  operation: ExternalOperationProgressPathInput,
  now: Date | string | number,
) {
  if (operation.terminalAt != null || TERMINAL_STATE_SET.has(operation.state)) return false;

  const nowMs = typeof now === "number" ? now : readDateMs(now);
  const nextCheckAtMs = readDateMs(operation.nextCheckAt);
  const timeoutAtMs = readDateMs(operation.timeoutAt);
  if (nowMs === null || nextCheckAtMs === null || timeoutAtMs === null) return false;
  if (timeoutAtMs <= nowMs || nextCheckAtMs > timeoutAtMs) return false;

  const { attemptCount, maxAttempts } = readExternalOperationControllerAttemptState(
    operation.metadata,
  );
  return attemptCount < maxAttempts;
}
