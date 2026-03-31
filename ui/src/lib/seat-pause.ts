import type { SeatPauseReason } from "@paperclipai/shared";

const SEAT_PAUSE_REASON_LABELS: Record<SeatPauseReason, string> = {
  budget_enforcement: "Budget enforcement",
  manual_admin: "Manual admin",
  maintenance: "Maintenance",
};

export function formatSeatPauseReason(reason: SeatPauseReason | null | undefined): string | null {
  if (!reason) return null;
  return SEAT_PAUSE_REASON_LABELS[reason] ?? reason;
}

export function formatSeatPauseReasons(reasons: SeatPauseReason[] | null | undefined): string {
  if (!reasons || reasons.length === 0) return "none";
  return reasons
    .map((reason) => formatSeatPauseReason(reason) ?? reason)
    .join(", ");
}
