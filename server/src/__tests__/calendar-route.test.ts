import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calendarRoutes } from "../routes/calendar.js";
import { errorHandler } from "../middleware/index.js";

const mockCalendarService = vi.hoisted(() => ({
  getEvents: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  calendarService: () => mockCalendarService,
}));

function makeApp(actorType: "board" | "agent" = "board", actorCompanyId = "company-1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (actorType === "board") {
      // local_implicit bypasses company membership check in assertCompanyAccess
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        companyIds: [actorCompanyId],
        userId: "user-1",
        isInstanceAdmin: false,
      };
    } else {
      (req as any).actor = {
        type: "agent",
        companyId: actorCompanyId,
        agentId: "agent-1",
        runId: null,
      };
    }
    next();
  });
  app.use(calendarRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeEvent(overrides = {}) {
  return {
    id: "trigger:abc123",
    kind: "routine",
    title: "Topic Intelligence Report",
    cronExpression: "0 8 * * 1",
    timezone: "America/New_York",
    nextRunAt: "2026-04-14T12:00:00.000Z",
    status: "active",
    assigneeAgentId: "agent-1",
    routineId: "routine-1",
    triggerId: "trigger-abc123",
    ...overrides,
  };
}

describe("GET /api/companies/:companyId/calendar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns events for a company within the requested window", async () => {
    const events = [
      makeEvent(),
      makeEvent({
        id: "plugin-job:xyz456",
        kind: "plugin_job",
        title: "YouTube Weekly Report",
        cronExpression: "0 9 * * 0",
        timezone: "UTC",
        nextRunAt: "2026-04-20T09:00:00.000Z",
        assigneeAgentId: null,
        routineId: null,
        triggerId: null,
        pluginJobId: "job-xyz456",
      }),
    ];
    mockCalendarService.getEvents.mockResolvedValue(events);

    const res = await request(makeApp())
      .get("/companies/company-1/calendar")
      .query({ start: "2026-04-01T00:00:00.000Z", end: "2026-05-01T00:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events });
    expect(mockCalendarService.getEvents).toHaveBeenCalledWith(
      "company-1",
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("defaults start and end to next 30 days when not provided", async () => {
    mockCalendarService.getEvents.mockResolvedValue([]);

    const res = await request(makeApp()).get("/companies/company-1/calendar");

    expect(res.status).toBe(200);
    expect(mockCalendarService.getEvents).toHaveBeenCalledWith(
      "company-1",
      expect.any(Date),
      expect.any(Date),
    );
    const [, start, end] = mockCalendarService.getEvents.mock.calls[0]!;
    const diffDays = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(30, 0);
  });

  it("returns 403 when board requests calendar for a company they lack access to", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      // Board actor with access only to company-2, not company-1
      (req as any).actor = {
        type: "board",
        source: "authenticated",
        companyIds: ["company-2"],
        userId: "user-1",
        isInstanceAdmin: false,
      };
      next();
    });
    app.use(calendarRoutes({} as any));
    app.use(errorHandler);

    const res = await request(app).get("/companies/company-1/calendar");

    expect(res.status).toBe(403);
    expect(mockCalendarService.getEvents).not.toHaveBeenCalled();
  });

  it("allows agent callers with matching company access", async () => {
    mockCalendarService.getEvents.mockResolvedValue([]);

    const res = await request(makeApp("agent")).get("/companies/company-1/calendar");

    expect(res.status).toBe(200);
  });
});
