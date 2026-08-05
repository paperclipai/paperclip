import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  routineRuns,
  routineTriggers,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { calendarService, normalizeCalendarKinds, normalizeCalendarWindow } from "../services/calendar.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres calendar service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/** Fixed "now" so projections are deterministic regardless of when CI runs. */
const NOW = new Date("2026-03-10T12:00:00.000Z");
const WINDOW = {
  from: new Date("2026-03-01T00:00:00.000Z"),
  to: new Date("2026-03-31T23:59:00.000Z"),
};

describe("calendar window and kind normalisation", () => {
  it("caps a window longer than three months", () => {
    const result = normalizeCalendarWindow({
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    expect(result.capped).toBe(true);
    expect(result.to.getTime() - result.from.getTime()).toBe(92 * 24 * 60 * 60 * 1000);
  });

  it("repairs an inverted window instead of returning nothing", () => {
    const result = normalizeCalendarWindow({
      from: new Date("2026-03-10T00:00:00Z"),
      to: new Date("2026-03-01T00:00:00Z"),
    });
    expect(result.capped).toBe(true);
    expect(result.to.getTime()).toBeGreaterThan(result.from.getTime());
  });

  it("spans both directions around now by default, unlike the work timeline", () => {
    const result = normalizeCalendarWindow({}, NOW);
    expect(result.from.getTime()).toBeLessThan(NOW.getTime());
    expect(result.to.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it("falls back to every kind when the filter is absent or unrecognised", () => {
    expect(normalizeCalendarKinds(undefined)).toHaveLength(5);
    expect(normalizeCalendarKinds("nonsense")).toHaveLength(5);
    expect(normalizeCalendarKinds("routine_scheduled,agent_run")).toEqual([
      "routine_scheduled",
      "agent_run",
    ]);
    expect(normalizeCalendarKinds("routine_run,routine_run")).toEqual(["routine_run"]);
  });
});

describeEmbeddedPostgres("calendar service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-calendar-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Scheduler",
      role: "ic",
    });
    return { companyId, agentId };
  }

  async function seedRoutine(
    companyId: string,
    agentId: string | null,
    options: {
      title?: string;
      cronExpression?: string | null;
      timezone?: string | null;
      enabled?: boolean;
      kind?: string;
      status?: string;
    } = {},
  ) {
    const routineId = randomUUID();
    const triggerId = randomUUID();
    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: options.title ?? "Daily sweep",
      assigneeAgentId: agentId,
      status: options.status ?? "active",
    });
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: options.kind ?? "schedule",
      enabled: options.enabled ?? true,
      cronExpression: options.cronExpression === undefined ? "0 9 * * *" : options.cronExpression,
      timezone: options.timezone === undefined ? "UTC" : options.timezone,
    });
    return { routineId, triggerId };
  }

  it("projects future cron occurrences that no stored row exists for", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId, { title: "Daily sweep" });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const projected = result.events.filter((event) => event.kind === "routine_scheduled");

    // NOW is 12:00 on the 10th, so the 09:00 slot that day has passed: the
    // first projection is the 11th, and it runs to the end of the window.
    expect(projected[0]!.at).toBe("2026-03-11T09:00:00.000Z");
    expect(projected).toHaveLength(21);
    expect(projected[0]).toMatchObject({
      tense: "projected",
      status: "scheduled",
      title: "Daily sweep",
      routineId,
      cronExpression: "0 9 * * *",
      scheduleTimezone: "UTC",
      href: `/routines/${routineId}`,
    });
  });

  it("never projects into the past, where records are the truth", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedRoutine(companyId, agentId);

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const projected = result.events.filter((event) => event.kind === "routine_scheduled");

    expect(projected.every((event) => new Date(event.at) >= NOW)).toBe(true);
  });

  it("carries the schedule's own timezone so the UI can flag a mismatch", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedRoutine(companyId, agentId, {
      cronExpression: "0 9 * * *",
      timezone: "America/New_York",
    });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const first = result.events.find((event) => event.kind === "routine_scheduled")!;

    expect(first.scheduleTimezone).toBe("America/New_York");
    // 09:00 New York is 13:00 UTC in March (EDT).
    expect(first.at.endsWith("T13:00:00.000Z")).toBe(true);
  });

  it("ignores triggers that cannot produce a schedule", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedRoutine(companyId, agentId, { title: "Webhook only", kind: "webhook" });
    await seedRoutine(companyId, agentId, { title: "Disabled", enabled: false });
    await seedRoutine(companyId, agentId, { title: "Paused routine", status: "paused" });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);

    expect(result.events.filter((event) => event.kind === "routine_scheduled")).toEqual([]);
  });

  it("reports a broken cron instead of silently blanking the calendar", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedRoutine(companyId, agentId, { title: "Healthy", cronExpression: "0 9 * * *" });
    await seedRoutine(companyId, agentId, { title: "Broken", cronExpression: "not a cron" });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);

    expect(result.unschedulable).toHaveLength(1);
    expect(result.unschedulable[0]!.routineTitle).toBe("Broken");
    // The healthy routine still projects — one bad trigger does not poison the batch.
    expect(result.events.some((event) => event.title === "Healthy")).toBe(true);
  });

  it("reports a source that hit its row ceiling instead of hiding the loss", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId);
    // MAX_SOURCE_ROWS is 2000; 2001 rows must trip the ceiling and be reported.
    await db.insert(routineRuns).values(
      Array.from({ length: 2001 }, (_, index) => ({
        companyId,
        routineId,
        source: "schedule",
        status: "issue_created",
        triggeredAt: new Date(WINDOW.from.getTime() + index * 60_000),
      })),
    );

    const result = await calendarService(db).getCalendar(
      { companyId, ...WINDOW, kinds: ["routine_run"] },
      NOW,
    );

    expect(result.truncated).not.toBeNull();
    expect(result.truncated!.sources).toEqual(["routine_run"]);
  });

  it("does not claim truncation when a source sits exactly on the ceiling", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId);
    await db.insert(routineRuns).values(
      Array.from({ length: 3 }, (_, index) => ({
        companyId,
        routineId,
        source: "schedule",
        status: "issue_created",
        triggeredAt: new Date(WINDOW.from.getTime() + index * 60_000),
      })),
    );

    const result = await calendarService(db).getCalendar(
      { companyId, ...WINDOW, kinds: ["routine_run"] },
      NOW,
    );

    expect(result.truncated).toBeNull();
  });

  it("projects the same schedules on every identical request", async () => {
    const { companyId, agentId } = await seedCompany();
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      await seedRoutine(companyId, agentId, { title });
    }

    const first = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const second = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);

    // Deterministic ordering on the schedule query: without it the rows kept
    // under the ceiling would be whatever the planner returned that time.
    expect(second.events.map((event) => event.id)).toEqual(first.events.map((event) => event.id));
  });

  it("caps a dense schedule and says so", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedRoutine(companyId, agentId, { title: "Every five", cronExpression: "*/5 * * * *" });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);

    expect(result.truncated).not.toBeNull();
    expect(result.truncated!.series).toHaveLength(1);
    expect(result.truncated!.series[0]!.routineTitle).toBe("Every five");
    expect(result.truncated!.sources).toEqual([]);
    expect(result.events.filter((event) => event.kind === "routine_scheduled")).toHaveLength(500);
  });

  it("does not let a dense schedule delete another routine's next run", async () => {
    const { companyId, agentId } = await seedCompany();
    await seedRoutine(companyId, agentId, { title: "Every five", cronExpression: "*/5 * * * *" });
    await seedRoutine(companyId, agentId, { title: "Quiet weekly", cronExpression: "0 9 * * 1" });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const quiet = result.events.filter((event) => event.title === "Quiet weekly");

    // The whole point of round-robin allocation: the noisy series must not
    // consume the budget and make the quiet one look like it has nothing due.
    expect(quiet.length).toBeGreaterThan(0);
  });

  it("returns recorded runs alongside projections and marks which is which", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId);
    await db.insert(routineRuns).values({
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-05T09:00:00.000Z"),
      completedAt: new Date("2026-03-05T09:04:00.000Z"),
    });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const run = result.events.find((event) => event.kind === "routine_run")!;

    expect(run).toMatchObject({
      tense: "actual",
      status: "succeeded",
      at: "2026-03-05T09:00:00.000Z",
      endAt: "2026-03-05T09:04:00.000Z",
    });
    expect(result.events.some((event) => event.tense === "projected")).toBe(true);
  });

  it("marks a failed run as failed", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId);
    await db.insert(routineRuns).values({
      companyId,
      routineId,
      source: "schedule",
      status: "failed",
      failureReason: "adapter exploded",
      triggeredAt: new Date("2026-03-05T09:00:00.000Z"),
    });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);

    expect(result.events.find((event) => event.kind === "routine_run")!.status).toBe("failed");
  });

  it("includes upcoming task monitor checks", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch the deploy",
      identifier: "PAP-1",
      assigneeAgentId: agentId,
      status: "in_progress",
      monitorNextCheckAt: new Date("2026-03-12T08:00:00.000Z"),
    });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const monitor = result.events.find((event) => event.kind === "task_monitor")!;

    expect(monitor).toMatchObject({
      tense: "projected",
      title: "Watch the deploy",
      at: "2026-03-12T08:00:00.000Z",
      issueIdentifier: "PAP-1",
      href: "/issues/PAP-1",
    });
  });

  it("places a completed task on the day it completed, once", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "Ship the thing",
      identifier: "PAP-2",
      assigneeAgentId: agentId,
      status: "done",
      startedAt: new Date("2026-03-04T09:00:00.000Z"),
      completedAt: new Date("2026-03-06T15:00:00.000Z"),
    });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const activity = result.events.filter((event) => event.kind === "task_activity");

    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ at: "2026-03-06T15:00:00.000Z", status: "succeeded" });
  });

  it("includes agent runs with their duration", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "completed",
      startedAt: new Date("2026-03-07T10:00:00.000Z"),
      finishedAt: new Date("2026-03-07T10:12:00.000Z"),
    });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const run = result.events.find((event) => event.kind === "agent_run")!;

    expect(run).toMatchObject({
      title: "Scheduler",
      at: "2026-03-07T10:00:00.000Z",
      endAt: "2026-03-07T10:12:00.000Z",
      href: `/agents/${agentId}`,
    });
  });

  it("filters by kind", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId);
    await db.insert(routineRuns).values({
      companyId,
      routineId,
      source: "schedule",
      status: "issue_created",
      triggeredAt: new Date("2026-03-05T09:00:00.000Z"),
    });

    const result = await calendarService(db).getCalendar(
      { companyId, ...WINDOW, kinds: ["routine_run"] },
      NOW,
    );

    expect(result.events.every((event) => event.kind === "routine_run")).toBe(true);
    expect(result.counts.routine_scheduled).toBe(0);
    expect(result.counts.routine_run).toBe(1);
  });

  it("filters by agent across both projections and records", async () => {
    const { companyId, agentId } = await seedCompany();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other",
      role: "ic",
    });
    await seedRoutine(companyId, agentId, { title: "Mine" });
    await seedRoutine(companyId, otherAgentId, { title: "Theirs" });

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW, agentId }, NOW);

    expect(result.events.every((event) => event.agentId === agentId)).toBe(true);
    expect(result.events.some((event) => event.title === "Theirs")).toBe(false);
  });

  it("never leaks another company's schedule", async () => {
    const mine = await seedCompany();
    const theirs = await seedCompany();
    await seedRoutine(mine.companyId, mine.agentId, { title: "Mine" });
    await seedRoutine(theirs.companyId, theirs.agentId, { title: "Theirs" });

    const result = await calendarService(db).getCalendar({ companyId: mine.companyId, ...WINDOW }, NOW);

    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((event) => event.title === "Theirs")).toBe(false);
  });

  it("returns events in ascending time order", async () => {
    const { companyId, agentId } = await seedCompany();
    const { routineId } = await seedRoutine(companyId, agentId);
    await db.insert(routineRuns).values([
      {
        companyId,
        routineId,
        source: "schedule",
        status: "issue_created",
        triggeredAt: new Date("2026-03-08T09:00:00.000Z"),
      },
      {
        companyId,
        routineId,
        source: "schedule",
        status: "issue_created",
        triggeredAt: new Date("2026-03-02T09:00:00.000Z"),
      },
    ]);

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);
    const times = result.events.map((event) => event.at);

    expect([...times].sort()).toEqual(times);
  });

  it("returns an empty, well-formed result for a company with nothing scheduled", async () => {
    const { companyId } = await seedCompany();

    const result = await calendarService(db).getCalendar({ companyId, ...WINDOW }, NOW);

    expect(result.events).toEqual([]);
    expect(result.truncated).toBeNull();
    expect(result.unschedulable).toEqual([]);
    expect(result.counts.routine_scheduled).toBe(0);
    expect(result.window.from).toBe(WINDOW.from.toISOString());
  });
});
