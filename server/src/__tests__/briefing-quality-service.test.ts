import { describe, expect, it, vi } from "vitest";
import type { FlightCrewBriefing } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";

import { briefingQualityService, classify } from "../services/briefing-quality.js";

function createMockBriefing(overrides?: Partial<FlightCrewBriefing>): FlightCrewBriefing {
  return {
    tripId: "trip-1",
    dutyDayId: "day-1",
    overview: {
      flightDate: "2026-05-11",
      departure: "KJFK",
      arrival: "KLAX",
      aircraftType: "B737",
      flightNumber: "AA100",
      crewPosition: "Captain",
      scheduledDeparture: "14:00 UTC",
      scheduledArrival: "17:30 UTC",
    },
    weather: {
      departure: { station: "KJFK", metar: "KJFK 111400Z ...", taf: "KJFK 111400Z ..." },
      arrival: { station: "KLAX", metar: "KLAX 111400Z ...", taf: "KLAX 111400Z ..." },
      alternate: null,
      enroute: [],
    },
    notams: {
      departure: [{ id: "N001", location: "KJFK", type: "closure", description: "Runway 13L closed", startTime: "2026-05-11T12:00Z", endTime: "2026-05-11T18:00Z", severity: "high" }],
      arrival: [{ id: "N002", location: "KLAX", type: "taxiway", description: "Taxiway B construction", startTime: "2026-05-11T10:00Z", endTime: "2026-05-11T20:00Z", severity: "medium" }],
      enroute: [],
    },
    route: {
      departure: "KJFK",
      arrival: "KLAX",
      alternate: "KORD",
      filedAltitude: "FL350",
      estimatedTimeEnroute: "3:30",
      fuelOnBoard: "15000 lbs",
      distance: "2475 nm",
    },
    alerts: {
      items: [
        { id: "ALT001", type: "weather", title: "Thunderstorms at KLAX", description: "Isolated thunderstorms expected", severity: "warning" },
      ],
    },
    ...overrides,
  };
}

function createMockDb(): Db {
  const onConflictDoUpdate = vi.fn().mockResolvedValue([]);
  const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate });
  return {
    insert: vi.fn().mockReturnValue({ values: valuesFn }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]), orderBy: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    transaction: vi.fn(),
  } as unknown as Db;
}

describe("briefing quality service", () => {
  describe("classify", () => {
    it("classifies a complete valid briefing as premium", () => {
      const result = classify("briefing-1", createMockBriefing());

      expect(result.briefingId).toBe("briefing-1");
      expect(result.label).toBe("premium");
      expect(result.overallScore).toBeGreaterThanOrEqual(4.5);
      expect(result.dimensionScores).toHaveLength(5);
      expect(result.gateResults).toHaveLength(13);

      const dimNames = result.dimensionScores.map((d) => d.dimension);
      expect(dimNames).toContain("accuracy");
      expect(dimNames).toContain("completeness");
      expect(dimNames).toContain("timeliness");
      expect(dimNames).toContain("clarity_presentation");
      expect(dimNames).toContain("operational_usefulness");
    });

    it("classifies a briefing with placeholder data as degraded or failed", () => {
      const briefing = createMockBriefing({
        overview: {
          flightDate: "",
          departure: "",
          arrival: "",
          aircraftType: "TBD",
          flightNumber: "",
          crewPosition: "TODO",
          scheduledDeparture: "",
          scheduledArrival: "",
        },
      });

      const result = classify("briefing-2", briefing);

      expect(["degraded", "failed"]).toContain(result.label);
      expect(result.overallScore).toBeLessThan(3.5);

      const accuracyGate = result.gateResults.find((g) => g.gateId === "A1");
      expect(accuracyGate?.passed).toBe(false);

      const b9Gate = result.gateResults.find((g) => g.gateId === "B9");
      expect(b9Gate?.passed).toBe(false);
    });

    it("all accuracy gates pass for a well-formed briefing", () => {
      const result = classify("briefing-3", createMockBriefing());

      const accuracyGates = result.gateResults.filter((g) => g.dimension === "accuracy");
      expect(accuracyGates.length).toBeGreaterThan(0);
      for (const gate of accuracyGates) {
        expect(gate.passed).toBe(true);
      }
    });

    it("completeness gate B9 fails on placeholder content", () => {
      const briefing = createMockBriefing({
        overview: {
          flightDate: "2026-05-11",
          departure: "KJFK",
          arrival: "KLAX",
          aircraftType: "TBD",
          flightNumber: "AA100",
          crewPosition: "Captain",
          scheduledDeparture: "14:00 UTC",
          scheduledArrival: "17:30 UTC",
        },
      });

      const result = classify("briefing-4", briefing);
      const b9 = result.gateResults.find((g) => g.gateId === "B9");
      expect(b9?.passed).toBe(false);
    });

    it("overall score is the average of 5 dimension scores", () => {
      const result = classify("briefing-5", createMockBriefing());

      const manualAvg = result.dimensionScores.reduce((s, d) => s + d.score, 0) / result.dimensionScores.length;
      const roundedManual = Math.round(manualAvg * 100) / 100;
      expect(result.overallScore).toBe(roundedManual);
    });

    it("assigned from same briefing reclassifies (upsert)", async () => {
      const svc = briefingQualityService(createMockDb());
      const result = await svc.classifyAndStore("briefing-6", createMockBriefing());
      expect(result.briefingId).toBe("briefing-6");
    });
  });

  describe("label assignment", () => {
    it("assigns premium label at score >= 4.5 with no gate failures", () => {
      const result = classify("premium-test", createMockBriefing());
      expect(result.label).toBe("premium");
      expect(result.overallScore).toBeGreaterThanOrEqual(4.5);
    });

    it("assigns failed label when more than 2 mandatory gates fail", () => {
      const briefing = createMockBriefing({
        overview: {
          flightDate: "",
          departure: "",
          arrival: "",
          aircraftType: "",
          flightNumber: "",
          crewPosition: "",
          scheduledDeparture: "",
          scheduledArrival: "",
        },
        route: {
          departure: "",
          arrival: "",
          alternate: null,
          filedAltitude: "",
          estimatedTimeEnroute: "",
          fuelOnBoard: "",
          distance: "",
        },
      });

      const result = classify("failed-test", briefing);
      expect(result.label).toBe("failed");
    });
  });
});
