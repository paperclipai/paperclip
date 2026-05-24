import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FlightCrewBriefing } from "@paperclipai/shared";

const mockGetBriefing = vi.hoisted(() => vi.fn());
const mockGetBriefingHtml = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    getBriefing: mockGetBriefing,
    getBriefingHtml: mockGetBriefingHtml,
  }));
}

function makeBriefing(tripId: string, dutyDayId: string): FlightCrewBriefing {
  return {
    tripId,
    dutyDayId,
    overview: {
      flightDate: "2026-05-24",
      departure: "KLAX",
      arrival: "KJFK",
      aircraftType: "Boeing 737-800",
      flightNumber: "CMF-417",
      crewPosition: "Captain",
      scheduledDeparture: "14:30 UTC",
      scheduledArrival: "22:45 UTC",
    },
    weather: {
      departure: { station: "KLAX", metar: "KLAX 251150Z 25008KT 10SM FEW025", taf: "KLAX 251120Z 2512/2618 26010KT" },
      arrival: { station: "KJFK", metar: "KJFK 251150Z 18012KT 6SM -RA", taf: "KJFK 251120Z 2512/2618 18012KT" },
      alternate: null,
      enroute: [{ segment: "KLAX-KDMA", conditions: "Clear", severity: "low", details: "No significant weather" }],
    },
    notams: {
      departure: [{ id: "N001", location: "KLAX", type: "Airport", description: "RWY 24L CLSD", startTime: "2026-05-24T06:00Z", endTime: "2026-05-26T23:59Z", severity: "high" }],
      arrival: [{ id: "N002", location: "KJFK", type: "Airport", description: "RWY 13R RESTRICTED", startTime: "2026-05-25T12:00Z", endTime: "2026-05-25T23:59Z", severity: "medium" }],
      enroute: [],
    },
    route: {
      departure: "KLAX",
      arrival: "KJFK",
      alternate: "KPHL",
      filedAltitude: "FL370",
      estimatedTimeEnroute: "4:15",
      fuelOnBoard: "28500 lbs",
      distance: "2475 nm",
    },
    alerts: {
      items: [
        { id: "ALT-WX-001", type: "weather", title: "Arrival crosswind advisory", description: "Crosswind 12G20", severity: "warning" },
      ],
    },
  };
}

async function createApp() {
  const [{ crewbriefBriefingRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/crewbrief-briefing.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use("/briefings", crewbriefBriefingRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("GET /briefings/:tripId/:dutyDayId", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
  });

  it("returns JSON briefing when found", async () => {
    const briefing = makeBriefing("trip-1", "day-1");
    mockGetBriefing.mockResolvedValue(briefing);

    const app = await createApp();
    const res = await request(app).get("/briefings/trip-1/day-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tripId: "trip-1",
      dutyDayId: "day-1",
      overview: expect.objectContaining({ flightNumber: "CMF-417" }),
      weather: expect.objectContaining({ departure: expect.objectContaining({ station: "KLAX" }) }),
      notams: expect.objectContaining({ departure: expect.any(Array) }),
      route: expect.objectContaining({ departure: "KLAX" }),
      alerts: expect.objectContaining({ items: expect.any(Array) }),
    });
    expect(mockGetBriefing).toHaveBeenCalledWith(expect.anything(), "trip-1", "day-1");
  });

  it("returns 404 JSON when briefing not found", async () => {
    mockGetBriefing.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app).get("/briefings/trip-missing/day-missing");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: "Briefing not found" });
  });

  it("returns HTML when Accept header includes text/html", async () => {
    const htmlContent = "<html><body>Briefing</body></html>";
    mockGetBriefingHtml.mockResolvedValue(htmlContent);

    const app = await createApp();
    const res = await request(app)
      .get("/briefings/trip-1/day-1")
      .set("Accept", "text/html");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
    expect(res.text).toBe(htmlContent);
    expect(mockGetBriefingHtml).toHaveBeenCalledWith(expect.anything(), "trip-1", "day-1");
    expect(mockGetBriefing).not.toHaveBeenCalled();
  });

  it("returns 404 HTML when briefing not found and Accept is text/html", async () => {
    mockGetBriefingHtml.mockResolvedValue(null);

    const app = await createApp();
    const res = await request(app)
      .get("/briefings/trip-missing/day-missing")
      .set("Accept", "text/html");

    expect(res.status).toBe(404);
    expect(res.text).toBe("Briefing not found");
  });
});
