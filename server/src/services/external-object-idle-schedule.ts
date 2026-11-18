import { idleDeadlineRowLimit, isFutureIdleDeadline, type IdleDeadlineSnapshot } from "./idle-deadline-types.js";

export type IdleExternalObjectRow = {
  id: string; companyId: string; companyStatus: string; revision: string;
  eligible: boolean; nextRefreshAt: Date | null;
  refreshStartedAt: Date | null; refreshToken: string | null;
};

export function projectIdleExternalObjectSchedule(rows: IdleExternalObjectRow[], now: number,
  enabled: boolean | null): IdleDeadlineSnapshot {
  const state = { enabled, rows };
  const deadlines: number[] = [];
  const blocked = () => ({ blocked: true, state, deadlines: [] });
  if (enabled === null || !Number.isFinite(now) || rows.length > idleDeadlineRowLimit) return blocked();
  for (const object of rows) {
    if (object.refreshStartedAt || object.refreshToken) return blocked();
    if (enabled && !["active", "paused", "archived"].includes(object.companyStatus)) return blocked();
    if (!enabled || object.eligible === false) continue;
    if (object.eligible !== true || !object.nextRefreshAt) return blocked();
    const at = object.nextRefreshAt.getTime();
    if (!isFutureIdleDeadline(at, now)) return blocked();
    deadlines.push(at);
  }
  return { blocked: false, state, deadlines };
}
