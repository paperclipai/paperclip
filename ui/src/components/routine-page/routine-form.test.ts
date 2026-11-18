import type { RoutineTrigger } from "@paperclipai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { routinesApi } from "@/api/routines";
import { responsibilitiesApi } from "@/api/responsibilities";
import { EMPTY_ROUTINE_FORM_DRAFT } from "./RoutineEditDialog";
import { routineFieldsChanged, routineFieldsPayload, syncRoutineResponsibility, syncRoutineSchedule } from "./routine-form";
import { resolveRoutineAddress, routinePath } from "./routine-routes";
import { webhookHealth } from "./routine-summary";

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

  it("creates, changes and removes the first schedule to match the form", async () => {
    expect(await syncRoutineSchedule("routine-1", [], null)).toBe(false);
    await syncRoutineSchedule("routine-1", [], { cronExpression: "0 8 * * *", timezone: "UTC" });
    expect(routinesApi.createTrigger).toHaveBeenCalledWith("routine-1", { kind: "schedule", cronExpression: "0 8 * * *", timezone: "UTC" });
    expect(await syncRoutineSchedule("routine-1", [schedule], { cronExpression: "0 9 * * 1-5", timezone: "UTC" })).toBe(false);
    await syncRoutineSchedule("routine-1", [schedule], { cronExpression: "0 10 * * 1-5", timezone: "UTC" });
    expect(routinesApi.updateTrigger).toHaveBeenCalledWith("schedule-1", { cronExpression: "0 10 * * 1-5", timezone: "UTC" });
    await syncRoutineSchedule("routine-1", [schedule], null);
    expect(routinesApi.updateTrigger).toHaveBeenLastCalledWith("schedule-1", { archived: true });
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
