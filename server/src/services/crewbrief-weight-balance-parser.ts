import type { ParseInput, ParseResult } from "./crewbrief-document-registry.js";
import { extractPdfText } from "./crewbrief-parser-utils.js";
import {
  parseWeightBalance,
  storeWeightBalanceData,
  type WeightBalanceData,
} from "./crewbrief-weight-balance.js";

function summarizeWeightBalance(parsed: WeightBalanceData): Record<string, unknown> {
  return {
    tripId: parsed.tripId,
    aircraftRegistration: parsed.aircraftRegistration ?? null,
    aircraftType: parsed.aircraftType ?? null,
    documentDate: parsed.documentDate ?? null,
    basicEmptyWeight: parsed.basicEmptyWeight ?? null,
    operatingEmptyWeight: parsed.operatingEmptyWeight ?? null,
    maxRampWeight: parsed.maxRampWeight ?? null,
    maxTakeoffWeight: parsed.maxTakeoffWeight ?? null,
    maxLandingWeight: parsed.maxLandingWeight ?? null,
    maxZeroFuelWeight: parsed.maxZeroFuelWeight ?? null,
    zeroFuelWeight: parsed.zeroFuelWeight ?? null,
    rampWeight: parsed.rampWeight ?? null,
    takeoffWeight: parsed.takeoffWeight ?? null,
    takeoffWeightCg: parsed.takeoffWeightCg ?? null,
    landingWeight: parsed.landingWeight ?? null,
    landingWeightCg: parsed.landingWeightCg ?? null,
    fuelUnit: parsed.fuelUnit ?? null,
    fuelRamp: parsed.fuelRamp ?? null,
    fuelTrip: parsed.fuelTrip ?? null,
    payload: parsed.payload ?? null,
    passengerCount: parsed.passengerCount ?? null,
    cargoWeight: parsed.cargoWeight ?? null,
    baggageWeight: parsed.baggageWeight ?? null,
    crewCount: parsed.crewCount ?? null,
    stationsCount: parsed.stations?.length ?? 0,
  } as Record<string, unknown>;
}

export async function parseWeightBalanceDocument(input: ParseInput): Promise<ParseResult> {
  try {
    const text = await extractPdfText(input.buffer);
    const parsed = await parseWeightBalance(text);

    await storeWeightBalanceData(input.db, input.documentId, parsed);

    const summary = summarizeWeightBalance(parsed);
    return { success: true, summary };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown parse error" };
  }
}
