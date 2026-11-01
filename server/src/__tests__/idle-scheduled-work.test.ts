import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { readIdleRoutineSchedule } from "../services/idle-scheduled-work.js";

const now = Date.UTC(2020, 0, 1);
const trigger = { id: "fixture", routine_id: "routine", company_id: "company", kind: "schedule",
  setup_pending: false, cron_expression: "*/15 * * * *", timezone: "UTC", scoped: true,
  next_run_at: new Date(now + 600_000), routine_updated: new Date(now), trigger_updated: new Date(now) };
function database(rows: unknown[]) {
  return { execute: vi.fn().mockResolvedValueOnce([{ blocked: false }]).mockResolvedValueOnce(rows) } as unknown as Pick<Db, "execute">;
}
describe("bounded idle routine catalog", () => {
  it("validates shared timezones once in a full-size catalog", async () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const rows = Array.from({ length: 10_000 }, (_, index) => ({ ...trigger, id: String(index) }));
      const result = await readIdleRoutineSchedule(database(rows), "owner", now);
      expect(result.blocked).toBe(false);
      expect(result.scheduledWake?.nextWakeAt).toBe(trigger.next_run_at.toISOString());
      expect(formatter).toHaveBeenCalledOnce();
    } finally { formatter.mockRestore(); }
  });
  it("refuses an oversized catalog before expensive timezone validation", async () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat");
    try {
      expect(await readIdleRoutineSchedule(database(Array(10_001).fill(trigger)), "owner", now))
        .toEqual({ blocked: true });
      expect(formatter).not.toHaveBeenCalled();
    } finally { formatter.mockRestore(); }
  });
});
