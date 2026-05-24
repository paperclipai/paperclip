import { createHash } from "node:crypto";
import type { FlightCrewBriefing } from "@paperclipai/shared";

function seedFromId(id: string): number {
  const hash = createHash("sha256").update(id).digest("hex");
  return parseInt(hash.slice(0, 8), 16);
}

function deterministicFlightNumber(seed: number): string {
  const num = 100 + (seed % 900);
  return `CMF-${num}`;
}

function deterministicStationCode(seed: number, offset: number): string {
  const stations = ["KLAX", "KJFK", "KATL", "KORD", "KDFW", "KDEN", "KSFO", "KSEA", "KMIA", "KBOS"];
  return stations[(seed + offset) % stations.length];
}

function pick<T>(arr: T[], seed: number, offset = 0): T {
  return arr[(seed + offset) % arr.length];
}

function randomMetar(station: string, seed: number): string {
  const windDir = 100 + (seed % 260);
  const windSpd = 5 + (seed % 20);
  const vis = 3 + (seed % 8);
  const temp = 10 + (seed % 20);
  const dew = temp - (2 + (seed % 6));
  return `${station} ${25000 + (seed % 100)}Z ${windDir}${windSpd}KT ${vis}SM FEW025 BKN200 ${temp}/${dew} A${2990 + (seed % 20)}`;
}

function randomTaf(station: string, seed: number): string {
  const windDir = 100 + (seed % 260);
  const windSpd = 5 + (seed % 20);
  const day = 25;
  return `${station} ${251120Z} ${day}12/${day + 1}18 ${windDir}${windSpd}KT P6SM FEW025 BKN200`;
}

export function briefingGenerationService() {
  function generate(tripId: string, dutyDayId: string): FlightCrewBriefing {
    const composite = `${tripId}::${dutyDayId}`;
    const seed = seedFromId(composite);
    const departure = deterministicStationCode(seed, 0);
    const arrival = deterministicStationCode(seed, 1);

    return {
      tripId,
      dutyDayId,
      overview: {
        flightDate: "2026-05-24",
        departure,
        arrival,
        aircraftType: "Boeing 737-800",
        flightNumber: deterministicFlightNumber(seed),
        crewPosition: pick(["Captain", "First Officer", "Relief Pilot"], seed, 2),
        scheduledDeparture: "14:30 UTC",
        scheduledArrival: "22:45 UTC",
      },
      weather: {
        departure: { station: departure, metar: randomMetar(departure, seed), taf: randomTaf(departure, seed) },
        arrival: { station: arrival, metar: randomMetar(arrival, seed + 100), taf: randomTaf(arrival, seed + 100) },
        alternate: null,
        enroute: [
          { segment: `${departure}-${arrival}`, conditions: "Clear", severity: "low" as const, details: "No significant weather" },
          { segment: `${arrival}-ALTN`, conditions: "Scattered clouds", severity: "low" as const, details: "VFR conditions" },
        ],
      },
      notams: {
        departure: [
          { id: `N${seed % 1000}`, location: departure, type: "Airport", description: "RWY 24L CLSD DUE TO WIP", startTime: "2026-05-24T06:00Z", endTime: "2026-05-26T23:59Z", severity: "high" as const },
          { id: `N${(seed + 1) % 1000}`, location: departure, type: "Airspace", description: "AIRSPACE RESERVATION ACTIVE", startTime: "2026-05-24T15:00Z", endTime: "2026-05-24T18:00Z", severity: "medium" as const },
        ],
        arrival: [
          { id: `N${(seed + 2) % 1000}`, location: arrival, type: "Airport", description: "RWY 13R RESTRICTED", startTime: "2026-05-25T12:00Z", endTime: "2026-05-25T23:59Z", severity: "medium" as const },
        ],
        enroute: seed % 3 === 0
          ? [{ id: `N${(seed + 3) % 1000}`, location: "ZLA", type: "Enroute", description: "NAV AID VOR/DME U/S", startTime: "2026-05-24T00:00Z", endTime: "2026-05-30T23:59Z", severity: "low" as const }]
          : [],
      },
      route: {
        departure,
        arrival,
        alternate: seed % 5 === 0 ? null : pick(["KPHL", "KCLT", "KSTL", "KIND"], seed, 10),
        filedAltitude: pick(["FL310", "FL330", "FL350", "FL370", "FL390"], seed, 3),
        estimatedTimeEnroute: pick(["4:15", "3:50", "5:10", "2:45", "6:30"], seed, 4),
        fuelOnBoard: `${25000 + (seed % 10000)} lbs`,
        distance: `${1500 + (seed % 2000)} nm`,
      },
      alerts: {
        items: [
          { id: `ALT-WX-${seed % 100}`, type: "weather", title: "Arrival crosswind advisory", description: "Crosswind 12G20 knots at destination", severity: "warning" as const },
          { id: `ALT-NT-${seed % 100}`, type: "notam", title: "Departure runway restriction", description: "Shortened runway due to WIP", severity: (seed % 3 === 0 ? "critical" : "info") as "info" | "warning" | "critical" },
        ],
      },
    };
  }

  return { generate };
}

export type BriefingGenerationService = ReturnType<typeof briefingGenerationService>;
