import { describe, expect, it } from "vitest";
import { briefingGenerationService } from "../services/briefing-generation.js";

const svc = briefingGenerationService();

describe("briefingGenerationService", () => {
  it("generates a valid FlightCrewBriefing with all required sections", () => {
    const briefing = svc.generate("trip-1", "day-1");

    expect(briefing.tripId).toBe("trip-1");
    expect(briefing.dutyDayId).toBe("day-1");

    expect(briefing.overview).toBeDefined();
    expect(briefing.overview.flightNumber).toMatch(/^CMF-\d{3}$/);
    expect(briefing.overview.departure).toMatch(/^K[A-Z]{3}$/);
    expect(briefing.overview.arrival).toMatch(/^K[A-Z]{3}$/);
    expect(briefing.overview.aircraftType).toBeTruthy();
    expect(typeof briefing.overview.crewPosition).toBe("string");

    expect(briefing.weather.departure.station).toBe(briefing.overview.departure);
    expect(briefing.weather.arrival.station).toBe(briefing.overview.arrival);

    expect(briefing.weather.departure.metar).toBeTruthy();
    expect(briefing.weather.departure.taf).toBeTruthy();
    expect(briefing.weather.arrival.metar).toBeTruthy();
    expect(briefing.weather.arrival.taf).toBeTruthy();

    expect(briefing.notams.departure.length).toBeGreaterThan(0);
    expect(briefing.notams.arrival.length).toBeGreaterThan(0);
    expect(Array.isArray(briefing.notams.enroute)).toBe(true);

    expect(briefing.route.departure).toBeTruthy();
    expect(briefing.route.arrival).toBeTruthy();
    expect(briefing.route.filedAltitude).toBeTruthy();
    expect(briefing.route.estimatedTimeEnroute).toBeTruthy();
    expect(briefing.route.fuelOnBoard).toBeTruthy();
    expect(briefing.route.distance).toBeTruthy();

    expect(briefing.alerts.items).toBeDefined();
  });

  it("produces deterministic output for the same inputs", () => {
    const a = svc.generate("trip-fixed", "day-fixed");
    const b = svc.generate("trip-fixed", "day-fixed");

    expect(a).toEqual(b);
  });

  it("produces different output for different tripIds", () => {
    const a = svc.generate("trip-alpha", "day-1");
    const b = svc.generate("trip-beta", "day-1");

    expect(a).not.toEqual(b);
  });

  it("produces different output for different dutyDayIds", () => {
    const a = svc.generate("trip-1", "day-morning");
    const b = svc.generate("trip-1", "day-evening");

    expect(a).not.toEqual(b);
  });

  it("weather section includes enroute data", () => {
    const briefing = svc.generate("trip-1", "day-1");

    expect(briefing.weather.enroute.length).toBeGreaterThan(0);
    for (const segment of briefing.weather.enroute) {
      expect(segment.segment).toBeTruthy();
      expect(segment.conditions).toBeTruthy();
      expect(["low", "medium", "high"]).toContain(segment.severity);
      expect(segment.details).toBeTruthy();
    }
  });

  it("alerts have valid severity values", () => {
    const briefing = svc.generate("trip-1", "day-1");

    for (const alert of briefing.alerts.items) {
      expect(["info", "warning", "critical"]).toContain(alert.severity);
      expect(alert.id).toBeTruthy();
      expect(alert.type).toBeTruthy();
      expect(alert.title).toBeTruthy();
      expect(alert.description).toBeTruthy();
    }
  });

  it("notams have valid severity values and structure", () => {
    const briefing = svc.generate("trip-n", "day-n");

    const allNotams = [
      ...briefing.notams.departure,
      ...briefing.notams.arrival,
      ...briefing.notams.enroute,
    ];

    for (const n of allNotams) {
      expect(["low", "medium", "high"]).toContain(n.severity);
      expect(n.id).toBeTruthy();
      expect(n.location).toBeTruthy();
      expect(n.type).toBeTruthy();
      expect(n.description).toBeTruthy();
      expect(n.startTime).toBeTruthy();
    }
  });

  it("route alternate can be null", () => {
    const briefing = svc.generate("trip-alt", "day-alt");
    if (briefing.route.alternate !== null) {
      expect(briefing.route.alternate).toMatch(/^K[A-Z]{3}$/);
    }
  });
});
