import { describe, expect, it } from "vitest";
import { callRoutineTool } from "../services/routine-tools.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ROUTINE = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const RESPONSIBILITY = "33333333-3333-4333-8333-333333333333";
const TRIGGER = "66666666-6666-4666-8666-666666666666";

function routine(overrides: Record<string, unknown> = {}) {
  return {
    id: ROUTINE, companyId: COMPANY, projectId: null, title: "Weekly pipeline", description: "Review the pipeline",
    assigneeAgentId: "agent-1", priority: "medium", status: "active", responsibleUserId: "person-1",
    latestRevisionId: "rev-1", latestRevisionNumber: 3, triggers: [], lastRun: null, ...overrides,
  };
}

/** Answers by "METHOD path" or path, and records each request. */
function fakeApi(routes: Record<string, unknown | (() => unknown)>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace("http://paperclip.test/api", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const route = routes[`${method} ${path}`] ?? routes[path];
    if (route === undefined) throw new Error(`unexpected request ${method} ${path}`);
    const body = typeof route === "function" ? (route as () => unknown)() : route;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetcher };
}

const base = { apiUrl: "http://paperclip.test/api", token: "agent-token", companyId: COMPANY, companyPrefix: "PAP" };

describe("routine tools", () => {
  it("lists routines filtered by words, person and a responsibility", async () => {
    const api = fakeApi({
      [`/companies/${COMPANY}/routines`]: [
        routine({ triggers: [{ id: TRIGGER, kind: "schedule", enabled: true, cronExpression: "0 9 * * 1", timezone: "Europe/Berlin", nextRunAt: null }] }),
        routine({ id: OTHER, title: "Daily standup", responsibleUserId: "person-2" }),
      ],
      [`/responsibilities/${RESPONSIBILITY}`]: { routines: [{ id: ROUTINE }] },
    });
    const result = await callRoutineTool({ ...base, name: "list_routines", arguments: { query: "pipeline", responsibleUserId: "person-1", responsibilityId: RESPONSIBILITY } }, api.fetcher);
    expect(result).toMatchObject({
      total: 1,
      routines: [{ id: ROUTINE, title: "Weekly pipeline", triggers: [{ triggerId: TRIGGER, cronExpression: "0 9 * * 1", timezone: "Europe/Berlin" }], href: `/PAP/routines/${ROUTINE}` }],
      truncated: false,
    });
  });

  it("lists active routines filed under no responsibility", async () => {
    const api = fakeApi({
      [`/companies/${COMPANY}/routines`]: [routine(), routine({ id: OTHER })],
      [`/companies/${COMPANY}/responsibilities`]: { loose: { routines: [{ id: OTHER }], routineCount: 1 } },
    });
    const result = await callRoutineTool({ ...base, name: "list_routines", arguments: { unfiled: true } }, api.fetcher);
    expect(result).toMatchObject({ total: 1, routines: [{ id: OTHER }], note: expect.stringContaining("1 in the company") });
  });

  it("changes a routine, sets its schedule in plain terms and files it, reporting how to undo", async () => {
    let reads = 0;
    const scheduled = [{ id: TRIGGER, kind: "schedule", enabled: false, cronExpression: "0 10 * * 1-5", timezone: "UTC", nextRunAt: null }];
    const api = fakeApi({
      [`GET /routines/${ROUTINE}`]: () => (reads++ === 0 ? routine({ triggers: scheduled }) : routine({ title: "Pipeline review", latestRevisionNumber: 5, triggers: scheduled })),
      [`PATCH /routines/${ROUTINE}`]: routine({ title: "Pipeline review" }),
      [`PATCH /routine-triggers/${TRIGGER}`]: {},
      [`POST /responsibilities/${RESPONSIBILITY}/file`]: { filed: [], unfiled: [] },
    });
    const result = await callRoutineTool({ ...base, name: "update_routine", arguments: {
      routineId: ROUTINE, title: "Pipeline review", instructions: "Review the pipeline and flag stalled deals",
      schedule: { frequency: "weekly", dayOfWeek: "monday", time: "09:30", timezone: "Europe/Berlin" }, fileUnder: RESPONSIBILITY,
    } }, api.fetcher);
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([
      { method: "PATCH", path: `/routines/${ROUTINE}`, body: { title: "Pipeline review", description: "Review the pipeline and flag stalled deals", baseRevisionId: "rev-1" } },
      { method: "PATCH", path: `/routine-triggers/${TRIGGER}`, body: { cronExpression: "30 9 * * 1", timezone: "Europe/Berlin", enabled: true } },
      { method: "POST", path: `/responsibilities/${RESPONSIBILITY}/file`, body: { items: [{ kind: "routine", id: ROUTINE }] } },
    ]);
    expect(result).toMatchObject({
      routine: { title: "Pipeline review", revision: 5 },
      schedule: { label: "Every Monday at 9:30 AM", cronExpression: "30 9 * * 1" },
      filedUnder: { responsibilityId: RESPONSIBILITY },
      undo: expect.stringContaining("restoring revision 3"),
    });
  });

  it("adds a schedule when there is none, and turns schedules off with null", async () => {
    const add = fakeApi({
      [`GET /routines/${ROUTINE}`]: routine(),
      [`POST /routines/${ROUTINE}/triggers`]: {},
    });
    await callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, schedule: { frequency: "weekdays", time: "08:00" } } }, add.fetcher);
    expect(add.calls.find((call) => call.method === "POST")?.body).toEqual({ kind: "schedule", cronExpression: "0 8 * * 1-5", timezone: "UTC" });

    const off = fakeApi({
      [`GET /routines/${ROUTINE}`]: routine({ triggers: [{ id: TRIGGER, kind: "schedule", enabled: true, cronExpression: "0 9 * * 1", timezone: "UTC", nextRunAt: null }] }),
      [`PATCH /routine-triggers/${TRIGGER}`]: {},
    });
    const result = await callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, schedule: null } }, off.fetcher);
    expect(off.calls.find((call) => call.method === "PATCH")?.body).toEqual({ enabled: false });
    expect(result).toMatchObject({ schedule: { turnedOff: 1 } });
  });

  it("refuses an empty change and a weekly schedule without its day", async () => {
    const api = fakeApi({ [`GET /routines/${ROUTINE}`]: routine() });
    await expect(callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE } }, api.fetcher)).rejects.toMatchObject({ status: 422 });
    await expect(callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, schedule: { frequency: "weekly", time: "09:00" } } }, api.fetcher))
      .rejects.toThrow(/dayOfWeek/);
  });
});
