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

/** A response with a status or headers; plain values answer 200. */
class Reply {
  constructor(readonly body: unknown, readonly status = 200, readonly headers: Record<string, string> = {}) {}
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
    const value = typeof route === "function" ? (route as () => unknown)() : route;
    const reply = value instanceof Reply ? value : new Reply(value);
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } });
  }) as typeof fetch;
  return { calls, fetcher };
}

const base = { apiUrl: "http://paperclip.test/api", token: "agent-token", companyId: COMPANY, companyPrefix: "PAP" };

describe("routine tools", () => {
  it("passes every filter to the routine list, so they apply before the limit", async () => {
    const query = new URLSearchParams({ q: "pipeline", status: "paused", responsibleUserId: "person-1", responsibilityId: RESPONSIBILITY, unfiled: "true" });
    const api = fakeApi({
      [`/companies/${COMPANY}/routines?${query}`]: [
        routine({ status: "paused", triggers: [{ id: TRIGGER, kind: "schedule", enabled: true, cronExpression: "0 9 * * 1", timezone: "Europe/Berlin", nextRunAt: null }] }),
        routine({ id: OTHER, status: "paused" }),
      ],
    });
    const result = await callRoutineTool({ ...base, name: "list_routines", arguments: {
      query: "pipeline", status: "paused", responsibleUserId: "person-1", responsibilityId: RESPONSIBILITY, unfiled: true, limit: 1,
    } }, api.fetcher);
    expect(result).toMatchObject({
      total: 2,
      routines: [{ id: ROUTINE, title: "Weekly pipeline", triggers: [{ triggerId: TRIGGER, cronExpression: "0 9 * * 1", timezone: "Europe/Berlin" }], href: `/PAP/routines/${ROUTINE}` }],
      truncated: true,
    });
  });

  it("changes a routine and its schedule in one call, files it, and reports each undo", async () => {
    let reads = 0;
    const scheduled = [{ id: TRIGGER, kind: "schedule", enabled: true, cronExpression: "30 9 * * 1", timezone: "Europe/Berlin", nextRunAt: null }];
    const api = fakeApi({
      [`GET /routines/${ROUTINE}`]: () => (reads++ === 0 ? routine() : routine({ title: "Pipeline review", latestRevisionNumber: 4, triggers: scheduled })),
      [`PATCH /routines/${ROUTINE}`]: routine({ title: "Pipeline review" }),
      [`POST /responsibilities/${RESPONSIBILITY}/file`]: new Reply({ filed: [], unfiled: [] }, 200,
        { "x-paperclip-dashboard-version": "version-7", "x-paperclip-dashboard-owner": "person-1" }),
    });
    const result = await callRoutineTool({ ...base, name: "update_routine", arguments: {
      routineId: ROUTINE, title: "Pipeline review", instructions: "Review the pipeline and flag stalled deals",
      schedule: { frequency: "weekly", dayOfWeek: "monday", time: "09:30", timezone: "Europe/Berlin" }, fileUnder: RESPONSIBILITY,
    } }, api.fetcher);
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual([
      { method: "PATCH", path: `/routines/${ROUTINE}`, body: {
        title: "Pipeline review", description: "Review the pipeline and flag stalled deals",
        schedule: { cronExpression: "30 9 * * 1", timezone: "Europe/Berlin" }, baseRevisionId: "rev-1",
      } },
      { method: "POST", path: `/responsibilities/${RESPONSIBILITY}/file`, body: { items: [{ kind: "routine", id: ROUTINE }] } },
    ]);
    expect(result).toMatchObject({
      routine: { title: "Pipeline review", revision: 4 },
      schedule: { label: "Every Monday at 9:30 AM", cronExpression: "30 9 * * 1", timezone: "Europe/Berlin" },
      filedUnder: { responsibilityId: RESPONSIBILITY, dashboardVersionId: "version-7", dashboardOwnerUserId: "person-1", undo: expect.stringContaining("Dashboard history") },
      undo: expect.stringMatching(/restoring revision 3 .*not the filing/),
    });
  });

  it("says what was saved when filing fails after the routine changed", async () => {
    let reads = 0;
    const api = fakeApi({
      [`GET /routines/${ROUTINE}`]: () => (reads++ === 0 ? routine() : routine({ title: "Pipeline review", latestRevisionNumber: 4 })),
      [`PATCH /routines/${ROUTINE}`]: routine({ title: "Pipeline review" }),
      [`POST /responsibilities/${RESPONSIBILITY}/file`]: new Reply({ error: "Responsibilities are not enabled", code: "responsibilities_disabled" }, 404),
    });
    const result = await callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, title: "Pipeline review", fileUnder: RESPONSIBILITY } }, api.fetcher);
    expect(result).toMatchObject({
      routine: { title: "Pipeline review", revision: 4 },
      filedUnder: { responsibilityId: RESPONSIBILITY, failed: true, error: "Responsibilities are not enabled", note: expect.stringContaining("was saved") },
      undo: expect.stringContaining("restoring revision 3"),
    });

    // A filing on its own still fails loudly: nothing else was saved.
    await expect(callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, fileUnder: RESPONSIBILITY } }, api.fetcher))
      .rejects.toMatchObject({ status: 404 });
  });

  it("leaves the zone to the server when none is given, and turns schedules off with null", async () => {
    const add = fakeApi({
      [`GET /routines/${ROUTINE}`]: routine(),
      [`PATCH /routines/${ROUTINE}`]: routine(),
    });
    await callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, schedule: { frequency: "weekdays", time: "08:00" } } }, add.fetcher);
    expect(add.calls.find((call) => call.method === "PATCH")?.body).toEqual({ schedule: { cronExpression: "0 8 * * 1-5" }, baseRevisionId: "rev-1" });

    const off = fakeApi({
      [`GET /routines/${ROUTINE}`]: routine({ triggers: [{ id: TRIGGER, kind: "schedule", enabled: true, cronExpression: "0 9 * * 1", timezone: "UTC", nextRunAt: null }] }),
      [`PATCH /routines/${ROUTINE}`]: routine(),
    });
    const result = await callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, schedule: null } }, off.fetcher);
    expect(off.calls.find((call) => call.method === "PATCH")?.body).toEqual({ schedule: null, baseRevisionId: "rev-1" });
    expect(result).toMatchObject({ schedule: { turnedOff: 1 } });
  });

  it("refuses an empty change and a weekly schedule without its day", async () => {
    const api = fakeApi({ [`GET /routines/${ROUTINE}`]: routine() });
    await expect(callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE } }, api.fetcher)).rejects.toMatchObject({ status: 422 });
    await expect(callRoutineTool({ ...base, name: "update_routine", arguments: { routineId: ROUTINE, schedule: { frequency: "weekly", time: "09:00" } } }, api.fetcher))
      .rejects.toThrow(/dayOfWeek/);
  });
});
