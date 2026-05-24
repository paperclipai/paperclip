import type { Db } from "@paperclipai/db";
import type { ParseInput, ParseResult } from "../services/crewbrief-document-registry.js";
import { parseFlightPlan, extractPdfText } from "../services/crewbrief-flight-plan.js";
import { storeParsedData } from "./crewbrief-jetinsight.js";

export async function parseFlightPlanDocument(input: ParseInput): Promise<ParseResult> {
  try {
    const text = await extractPdfText(input.buffer);
    const parsed = await parseFlightPlan(text);

    const itineraryShaped = {
      tripId: parsed.tripId,
      legs: [
        {
          legNumber: 1,
          flightNumber: parsed.flightNumber,
          origin: parsed.origin,
          destination: parsed.destination,
          alternate: parsed.alternate,
          aircraftRegistration: parsed.aircraftRegistration,
          filedAltitude: parsed.filedAltitude,
          estimatedTimeEnroute: parsed.estimatedTimeEnroute,
          distance: parsed.distance,
          fuelPlan: parsed.fuelPlan,
          fuelUnit: parsed.fuelUnit || "lbs",
          scheduledDeparture: parsed.scheduledDeparture,
          scheduledArrival: parsed.scheduledArrival,
        },
      ],
    };

    const counts = await storeParsedData(input.db, itineraryShaped);

    const summary: Record<string, unknown> = {
      ...(counts as unknown as Record<string, unknown>),
    };
    if (parsed.flightRules) summary.flightRules = parsed.flightRules;
    if (parsed.route) summary.route = parsed.route;
    if (parsed.personsOnBoard) summary.personsOnBoard = parsed.personsOnBoard;
    if (parsed.equipment) summary.equipment = parsed.equipment;
    if (parsed.wakeTurbulence) summary.wakeTurbulence = parsed.wakeTurbulence;

    return { success: true, summary };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown parse error" };
  }
}
