import type { SeatPauseReason } from "@paperclipai/shared";
import { formatMessage } from "../i18n";
import { getRuntimeLocale } from "../i18n/runtime";

const REASON_KEYS: Record<SeatPauseReason, string> = {
  budget_enforcement: "seatPause.budgetEnforcement",
  manual_admin: "seatPause.manualAdmin",
  maintenance: "seatPause.maintenance",
};

export function formatSeatPauseReason(reason: SeatPauseReason | null | undefined): string | null {
  if (!reason) return null;
  return formatMessage(getRuntimeLocale(), REASON_KEYS[reason] ?? reason);
}

export function formatSeatPauseReasons(reasons: SeatPauseReason[] | null | undefined): string {
  if (!reasons || reasons.length === 0) return formatMessage(getRuntimeLocale(), "seatPause.none");
  return reasons
    .map((reason) => formatSeatPauseReason(reason) ?? reason)
    .join(", ");
}
