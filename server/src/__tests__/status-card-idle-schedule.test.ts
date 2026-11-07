import { expect, it, vi } from "vitest";
import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { projectIdleStatusCardSchedule, readIdleStatusCardSchedule, type IdleStatusCardRow } from "../services/status-card-idle-schedule.js";

vi.mock("../services/status-cards.js", () => ({ statusCardService: vi.fn(() => ({ tickDueStatusCards: vi.fn() })) }));
vi.mock("../services/issues.js", () => ({ issueService: vi.fn(() => ({ update: vi.fn() })) }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: vi.fn(() => ({
  getExperimental: async () => ({ enableStatusCards: true }),
})) }));

const now = Date.UTC(2099, 0, 1);
function card(patch: Partial<IdleStatusCardRow> = {}): IdleStatusCardRow {
  return { id: "card", companyId: "company", companyStatus: "active", revision: "row:1",
    archivedAt: null, generatingIssueId: null, unfinishedUpdate: false,
    state: "active", refreshPolicy: { mode: "reactive", debounceSeconds: 60 },
    nextEvalAt: null, nextEvalReason: null, pendingChangeCount: 0, compiled: true, ...patch };
}

it("retains manual, unchanged reactive, archived and repaired-error history without deadlines", () => {
  const rows = [card(), card({ refreshPolicy: { mode: "manual" } }), card({ archivedAt: new Date(now) }), card({ state: "error" })];
  expect(projectIdleStatusCardSchedule(rows, now, true)).toMatchObject({ blocked: false, deadlines: [] });
});

it.each(["refresh", "membership", "policy", "retry", null])("keeps the exact future %s deadline", reason => {
  const at = new Date(now + 60_000);
  const row = card({ nextEvalAt: at, nextEvalReason: reason });
  expect(projectIdleStatusCardSchedule([row], now, true)).toMatchObject({ blocked: false, deadlines: [at.getTime()] });
  expect(row.nextEvalAt).toBe(at);
});

it.each([
  { nextEvalAt: new Date(now), nextEvalReason: "retry" },
  { nextEvalAt: new Date(Number.NaN) },
  { generatingIssueId: "task" }, { unfinishedUpdate: true },
  { pendingChangeCount: 1 }, { state: "compiling" }, { compiled: false },
  { refreshPolicy: { mode: "interval", intervalMinutes: 15 } },
  { refreshPolicy: { mode: "unknown" } }, { nextEvalReason: "unknown" }, { companyStatus: "unknown" },
])("blocks unfinished or unsupported card state %j", patch => {
  expect(projectIdleStatusCardSchedule([card(patch)], now, true).blocked).toBe(true);
});

it("does not erase a generation claim when disabled, inactive or archived", () => {
  for (const patch of [{}, { companyStatus: "paused" }, { archivedAt: new Date(now) }]) {
    expect(projectIdleStatusCardSchedule([card({ ...patch, generatingIssueId: "task" })], now, false).blocked).toBe(true);
  }
  expect(projectIdleStatusCardSchedule([card({ nextEvalAt: new Date(now - 1) })], now, false).blocked).toBe(false);
  expect(projectIdleStatusCardSchedule([], now, null).blocked).toBe(true);
});

it("refuses a dirty null-deadline card before querying and rejects an owner changed during the read", async () => {
  const select = vi.fn();
  const dirty = () => ({ revision: "owner:1", reconciled: false });
  expect((await readIdleStatusCardSchedule({ select } as unknown as Pick<Db, "select">, now, true, dirty)).blocked).toBe(true);
  expect(select).not.toHaveBeenCalled();
  let revision = "owner:1";
  const query = { from: () => query, innerJoin: () => query, orderBy: () => query,
    limit: async () => { revision = "owner:2"; return [card()]; } };
  select.mockReturnValue(query);
  const owner = () => ({ revision, reconciled: true });
  expect((await readIdleStatusCardSchedule({ select } as unknown as Pick<Db, "select">, now, true, owner)).blocked).toBe(true);
  query.limit = async () => [card()];
  expect((await readIdleStatusCardSchedule({ select } as unknown as Pick<Db, "select">, now, true, owner)).blocked).toBe(false);
});

it("blocks a deferred company's null card deadline even after the helper considers its sweep successful", async () => {
  const { statusCardEvaluationService } = await import("../services/status-card-evaluation.js");
  const { statusCardService } = await import("../services/status-cards.js");
  const { instanceSettingsService } = await import("../services/instance-settings.js");
  const tick = vi.fn().mockResolvedValueOnce({ evaluated: 0, enqueued: [], deferredCompanyIds: new Set(["company"]) })
    .mockResolvedValue({ evaluated: 1, enqueued: [], deferredCompanyIds: new Set() });
  const query = { from: () => query, innerJoin: () => query, orderBy: () => query, limit: async () => [card()] };
  const select = vi.fn(() => query);
  const service = statusCardEvaluationService({ select } as unknown as Db, { wakeup: vi.fn() });
  expect(statusCardService).toHaveBeenCalled();
  expect(instanceSettingsService).toHaveBeenCalled();
  vi.mocked(statusCardService).mock.results.at(-1)!.value.tickDueStatusCards = tick;
  await service.run(new AbortController().signal);
  const owner = () => ({ revision: "helper:success", reconciled: true });
  expect((await service.readIdleSchedule({ select } as unknown as Pick<Db, "select">, now, owner)).blocked).toBe(true);
  expect(select).not.toHaveBeenCalled();
  await service.run(new AbortController().signal);
  expect((await service.readIdleSchedule({ select } as unknown as Pick<Db, "select">, now, owner)).blocked).toBe(false);
});

it("keeps disabled reconstruction passive after the actual owner settles its feature gate", async () => {
  const { statusCardEvaluationService } = await import("../services/status-card-evaluation.js");
  const { instanceSettingsService } = await import("../services/instance-settings.js");
  const query = { from: () => query, innerJoin: () => query, orderBy: () => query, limit: async () => [card()] };
  const select = vi.fn(() => query);
  const service = statusCardEvaluationService({ select } as unknown as Db, { wakeup: vi.fn() });
  vi.mocked(instanceSettingsService).mock.results.at(-1)!.value.getExperimental = async () =>
    instanceExperimentalSettingsSchema.parse({ enableStatusCards: false });
  await service.run(new AbortController().signal);
  expect(await service.readIdleSchedule({ select } as unknown as Pick<Db, "select">, now,
    () => ({ revision: "disabled:settled", reconciled: true }))).toMatchObject({ blocked: false, deadlines: [] });
});
