import type { RoutineTrigger } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routinesApi } from "@/api/routines";
import { responsibilitiesApi } from "@/api/responsibilities";
import { EMPTY_ROUTINE_FORM_DRAFT } from "./RoutineEditDialog";
import { PartialRoutineSaveError, buildRoutineResponsibilityChoices, routineFieldsChanged, routineFieldsPayload, syncRoutineResponsibility, syncRoutineSchedule } from "./routine-form";
import { resolveRoutineAddress, routinePath } from "./routine-routes";
import { routinePausedNotice, routineStatusDetail, webhookHealth, webhookStatusKey } from "./routine-summary";

vi.mock("@/api/routines", () => ({ routinesApi: { createTrigger: vi.fn(), updateTrigger: vi.fn() } }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: { link: vi.fn(), unlink: vi.fn(), get: vi.fn() } }));

const schedule = { id: "schedule-1", kind: "schedule", cronExpression: "0 9 * * 1-5", timezone: "UTC" } as RoutineTrigger;

describe("routine form saving", () => {
  beforeEach(() => vi.clearAllMocks());

  it("only sends the fields the form edits", () => {
    const payload = routineFieldsPayload({ ...EMPTY_ROUTINE_FORM_DRAFT, title: "  Digest  ", env: {} });
    expect(payload).toEqual({ title: "Digest", description: null, projectId: null, assigneeAgentId: null, variables: [], env: null });
    expect(routineFieldsChanged({ ...EMPTY_ROUTINE_FORM_DRAFT, title: "A" }, { ...EMPTY_ROUTINE_FORM_DRAFT, title: "A", schedule: null })).toBe(false);
  });

  it("creates, changes and removes the schedule the form opened with", async () => {
    vi.mocked(routinesApi.createTrigger).mockResolvedValue({ trigger: { id: "schedule-new" } } as never);
    expect(await syncRoutineSchedule("routine-1", [], null, null)).toEqual({ changed: false, scheduleId: null });
    expect(await syncRoutineSchedule("routine-1", [], null, { cronExpression: "0 8 * * *", timezone: "UTC" })).toEqual({ changed: true, scheduleId: "schedule-new" });
    expect(routinesApi.createTrigger).toHaveBeenCalledWith("routine-1", { kind: "schedule", cronExpression: "0 8 * * *", timezone: "UTC" });
    expect(await syncRoutineSchedule("routine-1", [schedule], "schedule-1", { cronExpression: "0 9 * * 1-5", timezone: "UTC" })).toEqual({ changed: false, scheduleId: "schedule-1" });
    await syncRoutineSchedule("routine-1", [schedule], "schedule-1", { cronExpression: "0 10 * * 1-5", timezone: "UTC" });
    expect(routinesApi.updateTrigger).toHaveBeenCalledWith("schedule-1", { cronExpression: "0 10 * * 1-5", timezone: "UTC" });
    expect(await syncRoutineSchedule("routine-1", [schedule], "schedule-1", null)).toEqual({ changed: true, scheduleId: null });
    expect(routinesApi.updateTrigger).toHaveBeenLastCalledWith("schedule-1", { archived: true });
  });

  it("never touches another schedule when a removal is retried", async () => {
    const second = { ...schedule, id: "schedule-2", cronExpression: "0 18 * * *" } as RoutineTrigger;
    // The first save removed schedule-1; the form now stands for no schedule, and schedule-2 is left alone.
    expect(await syncRoutineSchedule("routine-1", [second], null, null)).toEqual({ changed: false, scheduleId: null });
    // Even when the form still points at the removed schedule.
    expect(await syncRoutineSchedule("routine-1", [second], "schedule-1", null)).toEqual({ changed: false, scheduleId: null });
    expect(routinesApi.updateTrigger).not.toHaveBeenCalled();
  });

  it("says what a partly finished save saved and what it did not", () => {
    expect(new PartialRoutineSaveError(["details", "schedule"], "responsibility", new Error("Not allowed")).message)
      .toBe("Saved the routine’s details and the schedule, but the responsibility couldn’t be updated (Not allowed). Save again to finish.");
  });

  it("moves the direct responsibility link", async () => {
    vi.mocked(responsibilitiesApi.get).mockResolvedValue({ routines: [{ id: "routine-1", linkId: "link-1" }] } as never);
    expect(await syncRoutineResponsibility("routine-1", "a", "a")).toBe(false);
    await syncRoutineResponsibility("routine-1", "old", "new");
    expect(responsibilitiesApi.link).toHaveBeenCalledWith("new", { routineId: "routine-1" });
    expect(responsibilitiesApi.unlink).toHaveBeenCalledWith("old", "link-1");
  });
});

describe("routine addresses", () => {
  it("sends old section links to the page and keeps the two sub-views", () => {
    expect(routinePath("r")).toBe("/routines/r");
    for (const section of ["overview", "triggers", "variables", "secrets", "delivery", "runs"]) {
      expect(resolveRoutineAddress({ routineId: "r", section })).toEqual({ view: "routine", redirectTo: "/routines/r" });
    }
    expect(resolveRoutineAddress({ routineId: "r" })).toEqual({ view: "routine", redirectTo: null });
    expect(resolveRoutineAddress({ routineId: "r", section: "history" })).toEqual({ view: "history", redirectTo: null });
    expect(resolveRoutineAddress({ routineId: "r", section: "activity" })).toEqual({ view: "activity", redirectTo: null });
    expect(resolveRoutineAddress({ routineId: "r", legacyTab: "history" })).toEqual({ view: "history", redirectTo: "/routines/r/history" });
  });
});

describe("webhook health", () => {
  const base = { kind: "webhook", enabled: true } as RoutineTrigger;
  it("tells a webhook put back into test mode from one still in first setup", () => {
    expect(webhookHealth({ ...base, setupPending: true, lastWebhookDelivery: null })).toBe("setup");
    expect(webhookHealth({ ...base, setupPending: true, lastWebhookDelivery: { status: "received", receivedAt: "x", test: false } })).toBe("testing");
    expect(webhookHealth({
      ...base,
      setupPending: true,
      lastWebhookDelivery: { status: "received", receivedAt: "y", test: true, previous: { status: "received", receivedAt: "x", test: false } },
    })).toBe("testing");
    expect(webhookHealth({ ...base, lastWebhookDelivery: { status: "received", receivedAt: "x", test: false } })).toBe("receiving");
  });
});

describe("responsibility choices", () => {
  it("indexes links and options once, staying fast for large lists", () => {
    const count = 5000;
    const options = Array.from({ length: count }, (_, index) => ({ id: `resp-${index}`, title: `Responsibility ${index}` }));
    const links = [
      ...Array.from({ length: count }, (_, index) => ({ id: `resp-${index}`, title: `Responsibility ${index}`, areaId: "area-1", ownerUserId: "u", via: "project" as const })),
      { id: "other-owner", title: "Someone else's", areaId: null, ownerUserId: "v", via: "direct" as const },
    ];
    const started = performance.now();
    const result = buildRoutineResponsibilityChoices({ links, options, areaTitles: new Map([["area-1", "Customers"]]), projectId: "project-1" });
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.onPage).toHaveLength(count + 1);
    expect(result.onPage[0]).toMatchObject({ areaTitle: "Customers", via: "project" });
    expect(result.choices).toHaveLength(count + 1);
    expect(result.choices[0]!.projectIds).toEqual(["project-1"]);
    expect(result.choices.at(-1)).toMatchObject({ id: "other-owner", projectIds: [] });
  });
});

describe("routine status copy", () => {
  it("names what a paused or draft routine skips", () => {
    expect(routinePausedNotice({ state: "active", hasWebhooks: true, hasSchedule: true })).toBeNull();
    expect(routinePausedNotice({ state: "paused", hasWebhooks: true, hasSchedule: true })).toBe("Scheduled runs are skipped and webhook events are ignored until this routine is on.");
    expect(routinePausedNotice({ state: "draft", hasWebhooks: true, hasSchedule: false })).toBe("Webhook events are ignored until this routine is on. The sending app gets an error.");
    expect(routinePausedNotice({ state: "paused", hasWebhooks: false, hasSchedule: true })).toBe("Scheduled runs are skipped until this routine is on.");
    expect(routinePausedNotice({ state: "paused", hasWebhooks: false, hasSchedule: false })).toBeNull();
  });

  it("explains when the routine runs next", () => {
    const base = { nextRun: null, hasEnabledWebhook: false, hasStandingCheck: false };
    expect(routineStatusDetail({ ...base, state: "draft" })).toBeNull();
    expect(routineStatusDetail({ ...base, state: "archived" })).toBe("No longer runs");
    expect(routineStatusDetail({ ...base, state: "paused" })).toBe("Run now still works");
    const now = new Date(2026, 10, 18, 8, 0);
    expect(routineStatusDetail({ ...base, state: "active", nextRun: new Date(2026, 10, 18, 9, 0), now })).toMatch(/^Next run today at /);
    expect(routineStatusDetail({ ...base, state: "active", hasEnabledWebhook: true })).toBe("Runs when a webhook arrives");
    expect(routineStatusDetail({ ...base, state: "active", hasStandingCheck: true })).toBe("Checked each time the agent wakes up");
    expect(routineStatusDetail({ ...base, state: "active" })).toBe("Only runs when you start it");
  });

  it("picks one webhook dialog status", () => {
    const hook = { kind: "webhook", enabled: true } as RoutineTrigger;
    const active = { routineActive: true, testing: false };
    expect(webhookStatusKey({ ...hook, setupPending: true, lastWebhookDelivery: null }, active)).toBe("setup");
    expect(webhookStatusKey({ ...hook, setupPending: true, lastWebhookDelivery: null }, { routineActive: true, testing: true })).toBe("setup_testing");
    expect(webhookStatusKey({ ...hook, setupPending: true, lastWebhookDelivery: { status: "received", receivedAt: "x", test: true } }, active)).toBe("test_received");
    expect(webhookStatusKey({ ...hook, setupPending: true, lastWebhookDelivery: { status: "rejected", receivedAt: "x", test: true } }, active)).toBe("test_rejected");
    // A real delivery from before a re-test is not a test result.
    expect(webhookStatusKey({ ...hook, setupPending: true, lastWebhookDelivery: { status: "received", receivedAt: "x", test: false } }, active)).toBe("testing");
    expect(webhookStatusKey({ ...hook, lastWebhookDelivery: { status: "received", receivedAt: "x", test: false } }, { routineActive: false, testing: false })).toBe("ignored_while_paused");
  });
});
