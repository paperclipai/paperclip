import type { SeatPauseReason } from "@paperclipai/shared";

const SEAT_PAUSE_METADATA_KEY = "pause";
const LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY = "budgetPause";

export const OPERATOR_MANAGED_SEAT_PAUSE_REASONS = ["manual_admin", "maintenance"] as const;
export type OperatorManagedSeatPauseReason = (typeof OPERATOR_MANAGED_SEAT_PAUSE_REASONS)[number];

export type SeatPauseInfo = {
  pauseReason: SeatPauseReason | null;
  pauseReasons: SeatPauseReason[];
};

function isSeatPauseReason(value: unknown): value is SeatPauseReason {
  return value === "budget_enforcement" || value === "manual_admin" || value === "maintenance";
}

function cloneSeatMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return { ...(metadata as Record<string, unknown>) };
}

function readExplicitSeatPauseReasons(metadata: unknown): SeatPauseReason[] {
  const next: SeatPauseReason[] = [];
  const values = cloneSeatMetadata(metadata);
  const pauseMetadata = values[SEAT_PAUSE_METADATA_KEY];
  if (pauseMetadata && typeof pauseMetadata === "object" && !Array.isArray(pauseMetadata)) {
    const pauseRecord = pauseMetadata as Record<string, unknown>;
    if (isSeatPauseReason(pauseRecord.reason)) {
      next.push(pauseRecord.reason);
    }
    if (Array.isArray(pauseRecord.reasons)) {
      for (const reason of pauseRecord.reasons) {
        if (isSeatPauseReason(reason)) next.push(reason);
      }
    }
  }

  const legacyBudgetPause = values[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY];
  if (
    legacyBudgetPause
    && typeof legacyBudgetPause === "object"
    && !Array.isArray(legacyBudgetPause)
    && (legacyBudgetPause as Record<string, unknown>).source === "budget"
  ) {
    next.push("budget_enforcement");
  }

  return Array.from(new Set(next));
}

function getSeatPauseReasonsForStatus(
  status: string | null | undefined,
  metadata: unknown,
): SeatPauseReason[] {
  const explicitReasons = readExplicitSeatPauseReasons(metadata);
  if (explicitReasons.length > 0) return explicitReasons;
  return status === "paused" ? ["manual_admin"] : [];
}

function buildSeatPauseMetadata(input: {
  metadata: unknown;
  pauseReasons: SeatPauseReason[];
  now?: Date;
  pausedAt?: string | null;
}): Record<string, unknown> | null {
  const next = cloneSeatMetadata(input.metadata);
  if (input.pauseReasons.length === 0) {
    delete next[SEAT_PAUSE_METADATA_KEY];
    delete next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY];
    return Object.keys(next).length > 0 ? next : null;
  }

  const pauseMetadata =
    next[SEAT_PAUSE_METADATA_KEY]
    && typeof next[SEAT_PAUSE_METADATA_KEY] === "object"
    && !Array.isArray(next[SEAT_PAUSE_METADATA_KEY])
      ? (next[SEAT_PAUSE_METADATA_KEY] as Record<string, unknown>)
      : null;
  const pausedAt =
    input.pausedAt
    ?? (typeof pauseMetadata?.pausedAt === "string" ? pauseMetadata.pausedAt : null)
    ?? input.now?.toISOString()
    ?? new Date().toISOString();

  next[SEAT_PAUSE_METADATA_KEY] = {
    reason: input.pauseReasons[0],
    reasons: input.pauseReasons,
    pausedAt,
  };

  if (input.pauseReasons.includes("budget_enforcement")) {
    const legacyBudgetPause =
      next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY]
      && typeof next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY] === "object"
      && !Array.isArray(next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY])
        ? (next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY] as Record<string, unknown>)
        : null;
    next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY] = {
      source: "budget",
      pausedAt:
        (typeof legacyBudgetPause?.pausedAt === "string" ? legacyBudgetPause.pausedAt : null)
        ?? pausedAt,
    };
  } else {
    delete next[LEGACY_SEAT_BUDGET_PAUSE_METADATA_KEY];
  }

  return next;
}

export function getSeatPauseInfo(input: {
  status: string | null | undefined;
  metadata: unknown;
}): SeatPauseInfo {
  const pauseReasons = getSeatPauseReasonsForStatus(input.status, input.metadata);
  return {
    pauseReason: pauseReasons[0] ?? null,
    pauseReasons,
  };
}

export function addSeatPauseReason(input: {
  metadata: unknown;
  currentStatus: string | null | undefined;
  reason: SeatPauseReason;
  now: Date;
}): Record<string, unknown> {
  const current = getSeatPauseInfo({
    status: input.currentStatus,
    metadata: input.metadata,
  });
  const pauseReasons = Array.from(new Set([...current.pauseReasons, input.reason]));
  return buildSeatPauseMetadata({
    metadata: input.metadata,
    pauseReasons,
    now: input.now,
  }) ?? {};
}

export function removeSeatPauseReason(input: {
  metadata: unknown;
  currentStatus: string | null | undefined;
  reason: SeatPauseReason;
}): { metadata: Record<string, unknown> | null } & SeatPauseInfo {
  const current = getSeatPauseInfo({
    status: input.currentStatus,
    metadata: input.metadata,
  });
  const pauseReasons = current.pauseReasons.filter((reason) => reason !== input.reason);
  return {
    pauseReason: pauseReasons[0] ?? null,
    pauseReasons,
    metadata: buildSeatPauseMetadata({
      metadata: input.metadata,
      pauseReasons,
    }),
  };
}

export function applySeatPauseInfo(input: {
  metadata: unknown;
  status: string | null | undefined;
  pauseReason?: SeatPauseReason | null;
  pauseReasons?: SeatPauseReason[] | null;
  pausedAt?: string | null;
}): Record<string, unknown> | null {
  if (input.status !== "paused") {
    return buildSeatPauseMetadata({
      metadata: input.metadata,
      pauseReasons: [],
    });
  }

  const pauseReasons = Array.from(
    new Set(
      [input.pauseReason, ...(input.pauseReasons ?? [])].filter((reason): reason is SeatPauseReason =>
        isSeatPauseReason(reason),
      ),
    ),
  );

  return buildSeatPauseMetadata({
    metadata: input.metadata,
    pauseReasons: pauseReasons.length > 0 ? pauseReasons : ["manual_admin"],
    pausedAt: input.pausedAt ?? null,
  });
}

export function isOperatorManagedSeatPauseReason(reason: SeatPauseReason | null | undefined): reason is OperatorManagedSeatPauseReason {
  return reason === "manual_admin" || reason === "maintenance";
}
