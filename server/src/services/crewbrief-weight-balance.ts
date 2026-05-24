import type { Db } from "@paperclipai/db";
import { crewbriefWeightBalance } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import {
  extractPdfText,
  callLLMWithFallback,
} from "./crewbrief-parser-utils.js";

export interface WeightBalanceData {
  tripId: string;
  aircraftRegistration?: string;
  aircraftType?: string;
  documentDate?: string;
  basicEmptyWeight?: string;
  basicEmptyWeightCg?: string;
  basicEmptyWeightMoment?: string;
  operatingEmptyWeight?: string;
  operatingEmptyWeightCg?: string;
  operatingEmptyWeightMoment?: string;
  maxRampWeight?: string;
  maxTakeoffWeight?: string;
  maxLandingWeight?: string;
  maxZeroFuelWeight?: string;
  zeroFuelWeight?: string;
  zeroFuelWeightCg?: string;
  zeroFuelWeightMoment?: string;
  rampWeight?: string;
  takeoffWeight?: string;
  takeoffWeightCg?: string;
  takeoffWeightMoment?: string;
  landingWeight?: string;
  landingWeightCg?: string;
  landingWeightMoment?: string;
  fuelUnit?: string;
  fuelRamp?: string;
  fuelTrip?: string;
  fuelContingency?: string;
  fuelAlternate?: string;
  fuelFinalReserve?: string;
  fuelTaxi?: string;
  payload?: string;
  passengerCount?: string;
  passengerWeight?: string;
  cargoWeight?: string;
  baggageWeight?: string;
  crewCount?: string;
  crewWeight?: string;
  stations?: Array<{
    station: string;
    weight: string;
    arm: string;
    moment: string;
  }>;
}

const SYSTEM_PROMPT = `You are an aviation weight and balance parser. Extract structured weight and balance data from the provided raw text extracted from a weight and balance PDF or document.

Return ONLY a JSON object matching this exact structure:
{
  "tripId": "unique identifier — use tail number + date, or flight number + date, or generate one",
  "aircraftRegistration": "tail number e.g. N12345",
  "aircraftType": "aircraft type e.g. Challenger 605",
  "documentDate": "date from the document in ISO format or as found",
  "basicEmptyWeight": "basic empty weight (BEW) as string with units",
  "basicEmptyWeightCg": "CG position for basic empty weight (e.g. inches aft datum or %MAC)",
  "basicEmptyWeightMoment": "moment for basic empty weight",
  "operatingEmptyWeight": "operating empty weight (OEW) as string with units",
  "operatingEmptyWeightCg": "CG position for operating empty weight",
  "operatingEmptyWeightMoment": "moment for operating empty weight",
  "maxRampWeight": "maximum ramp/taxi weight as string with units",
  "maxTakeoffWeight": "maximum takeoff weight (MTOW) as string with units",
  "maxLandingWeight": "maximum landing weight (MLW) as string with units",
  "maxZeroFuelWeight": "maximum zero fuel weight (MZFW) as string with units",
  "zeroFuelWeight": "actual zero fuel weight (ZFW) as string with units",
  "zeroFuelWeightCg": "CG position at zero fuel weight",
  "zeroFuelWeightMoment": "moment at zero fuel weight",
  "rampWeight": "ramp/taxi weight as string with units",
  "takeoffWeight": "takeoff weight as string with units",
  "takeoffWeightCg": "CG position at takeoff",
  "takeoffWeightMoment": "moment at takeoff",
  "landingWeight": "estimated landing weight as string with units",
  "landingWeightCg": "CG position at landing",
  "landingWeightMoment": "moment at landing",
  "fuelUnit": "lbs or kg",
  "fuelRamp": "fuel on board at ramp",
  "fuelTrip": "trip fuel burn",
  "fuelContingency": "contingency fuel",
  "fuelAlternate": "alternate fuel",
  "fuelFinalReserve": "final reserve fuel",
  "fuelTaxi": "taxi fuel",
  "payload": "total payload as string with units",
  "passengerCount": "number of passengers",
  "passengerWeight": "total passenger weight as string with units",
  "cargoWeight": "total cargo weight as string with units",
  "baggageWeight": "total baggage weight as string with units",
  "crewCount": "number of crew",
  "crewWeight": "total crew weight as string with units",
  "stations": [
    {
      "station": "station name or identifier (e.g. Front Galley, Aft Baggage, Main Cabin)",
      "weight": "weight at this station",
      "arm": "arm distance from datum",
      "moment": "moment at this station"
    }
  ]
}

Rules:
- Extract all weight values with their units (lbs or kg).
- Extract all CG positions, arms, and moments when available.
- If a value is not present in the text, OMIT the field from the response (do not include null or empty values).
- For tripId, use the tail number + date, or flight number + date.
- If the text does NOT contain weight and balance data, return { "error": "No weight and balance data found in provided text" }
- IMPORTANT: Return valid JSON only, no markdown, no code fences.`;

export function deterministicParseWeightBalance(text: string): WeightBalanceData | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 5) return null;

  const lowerLines = lines.map((l) => l.toLowerCase());
  const lowerText = text.toLowerCase();

  const hasWbIndicators =
    lowerText.includes("weight") ||
    lowerText.includes("balance") ||
    lowerText.includes("c.g.") ||
    lowerText.includes("cg") ||
    lowerText.includes("center of gravity") ||
    lowerText.includes("zero fuel") ||
    lowerText.includes("mtow") ||
    lowerText.includes("mlw") ||
    lowerText.includes("mzfw") ||
    lowerText.includes("bew") ||
    lowerText.includes("oew") ||
    lowerText.includes("basic empty") ||
    lowerText.includes("operating empty") ||
    lowerText.includes("takeoff weight") ||
    lowerText.includes("landing weight") ||
    lowerText.includes("ramp weight") ||
    lowerText.includes("payload") ||
    lowerText.includes("load distribution") ||
    lowerText.includes("loading manifest") ||
    lowerText.includes("station");

  if (!hasWbIndicators) return null;

  const result: WeightBalanceData = {
    tripId: `WB-${new Date().toISOString().slice(0, 10)}`,
  };

  const tailMatch = text.match(/\bN\d{1,5}[A-Z]{0,2}\b/) || text.match(/\b(C-|[A-Z]{2}-)?[A-Z0-9]{3,6}\b.*(?:tail|acft|aircraft|reg[#:]?)/i) || text.match(/(?:acft|aircraft|registration|reg[#:]?)[:\s]+([A-Z0-9-]+)/i);
  if (tailMatch && !tailMatch[0].match(/^\d+(\.\d+)?$/)) {
    const reg = tailMatch[1] || tailMatch[0];
    if (reg.startsWith("N") && reg.length > 3) {
      result.aircraftRegistration = reg;
    }
  }

  const dateMatch = text.match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/) || text.match(/(\d{4}-\d{2}-\d{2})/) || text.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})/i);
  if (dateMatch) {
    result.documentDate = dateMatch[1];
  }

  const dateLineMatch = text.match(/Date[:\s]+([A-Za-z0-9\/\-\s,]+)/i);
  if (dateLineMatch && dateLineMatch[1].trim().length > 4) {
    result.documentDate = dateLineMatch[1].trim();
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = lowerLines[i];

    if (lower.includes("basic empty weight") || lower.includes("bew")) {
      const val = extractNumberAfterLabel(line, ["basic empty weight", "bew"], lines, i);
      if (val) result.basicEmptyWeight = val;
      continue;
    }

    if (lower.includes("operating empty weight") || lower.includes("oew")) {
      const val = extractNumberAfterLabel(line, ["operating empty weight", "oew"], lines, i);
      if (val) result.operatingEmptyWeight = val;
      continue;
    }

    if (lower.includes("max takeoff") || lower.includes("mtow") || (lower.includes("takeoff") && lower.includes("weight") && lower.includes("max"))) {
      const val = extractNumberAfterLabel(line, ["max takeoff", "mtow", "maximum takeoff"], lines, i);
      if (val) result.maxTakeoffWeight = val;
      continue;
    }

    if (lower.includes("max landing") || lower.includes("mlw") || (lower.includes("landing") && lower.includes("weight") && lower.includes("max"))) {
      const val = extractNumberAfterLabel(line, ["max landing", "mlw", "maximum landing"], lines, i);
      if (val) result.maxLandingWeight = val;
      continue;
    }

    if (lower.includes("max zero fuel") || lower.includes("mzfw") || (lower.includes("zero fuel") && lower.includes("max"))) {
      const val = extractNumberAfterLabel(line, ["max zero fuel", "mzfw", "maximum zero fuel"], lines, i);
      if (val) result.maxZeroFuelWeight = val;
      continue;
    }

    if (lower.includes("zero fuel weight") || (lower.includes("zero fuel") && !lower.includes("max")) || lower.includes("zfw:")) {
      const val = extractNumberAfterLabel(line, ["zero fuel weight", "zfw"], lines, i);
      if (val) result.zeroFuelWeight = val;
      continue;
    }

    if (lower.includes("max ramp") || lower.includes("maximum ramp")) {
      const val = extractNumberAfterLabel(line, ["max ramp", "maximum ramp"], lines, i);
      if (val) result.maxRampWeight = val;
      continue;
    }

    if (lower.includes("ramp weight") || lower.includes("taxi weight")) {
      const val = extractNumberAfterLabel(line, ["ramp weight", "taxi weight", "ramp"], lines, i);
      if (val) result.rampWeight = val;
      continue;
    }

    if ((lower.includes("takeoff weight") || lower.includes("take-off weight") || lower === "tow") && !lower.includes("max")) {
      const val = extractNumberAfterLabel(line, ["takeoff weight", "take-off weight", "tow"], lines, i);
      if (val) result.takeoffWeight = val;
      continue;
    }

    if ((lower.includes("landing weight") || lower === "law") && !lower.includes("max")) {
      const val = extractNumberAfterLabel(line, ["landing weight", "law"], lines, i);
      if (val) result.landingWeight = val;
      continue;
    }

    if (lower.includes("payload")) {
      const val = extractNumberAfterLabel(line, ["payload"], lines, i);
      if (val) result.payload = val;
      continue;
    }

    if (lower.includes("passenger")) {
      const match = line.match(/(\d+)\s*(?:pax|passengers?)/i) || line.match(/passengers?\s*[:#]?\s*(\d+)/i);
      if (match) result.passengerCount = match[1];
      continue;
    }

    if ((lower.includes("total fuel") || lower.includes("fuel on board") || lower.includes("fob")) && !lower.includes("max")) {
      const val = extractNumberAfterLabel(line, ["total fuel", "fuel on board", "fob", "fuel"], lines, i);
      if (val) result.fuelRamp = val;
      continue;
    }

    if (lower.includes("trip fuel") || lower.includes("burn fuel") || lower.includes("fuel burn") || (lower.includes("fuel") && lower.includes("trip"))) {
      const val = extractNumberAfterLabel(line, ["trip fuel", "fuel burn", "burn fuel"], lines, i);
      if (val) result.fuelTrip = val;
      continue;
    }
  }

  const stations = parseLoadStations(text, lines);
  if (stations.length > 0) {
    result.stations = stations;
  }

  const fuelUnitMatch = text.match(/\b(lbs?|pounds?|kg|kilograms?)\b/i);
  if (fuelUnitMatch) {
    const unit = fuelUnitMatch[1].toLowerCase();
    result.fuelUnit = unit.startsWith("k") ? "kg" : "lbs";
  }

  const typeMatch = text.match(/(?:(?:Aircraft|Acft)\s+Type|Aircraft|Type|Model)\s*:\s*([A-Za-z0-9\s/-]+)/i);
  if (typeMatch && typeMatch[1].trim().length > 3) {
    result.aircraftType = typeMatch[1].trim();
  }

  result.tripId = `WB-${result.aircraftRegistration || "ACFT"}-${new Date().toISOString().slice(0, 10)}`;

  const hasEssentialFields = !!(result.basicEmptyWeight || result.operatingEmptyWeight ||
    result.maxTakeoffWeight || result.takeoffWeight ||
    result.maxZeroFuelWeight || result.zeroFuelWeight ||
    result.fuelRamp || result.payload);

  if (!hasEssentialFields) return null;

  return result;
}

function parseLoadStations(text: string, lines: string[]): NonNullable<WeightBalanceData["stations"]> {
  const stations: NonNullable<WeightBalanceData["stations"]> = [];
  let inStationSection = false;
  let seenHeader = false;

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();

    if (lower.includes("station") && (lower.includes("weight") || lower.includes("load") || lower.includes("distribution") || lower.includes("arm") || lower.includes("moment"))) {
      inStationSection = true;
      seenHeader = true;
      continue;
    }

    if (!inStationSection) continue;

    if (lower.includes("total") || lower.includes("sum") || lower.includes("limit") || lower.includes("cg limits") || (lower.includes("zero fuel") && !lower.includes("station"))) {
      continue;
    }

    const parts = lines[i].split(/\s{2,}|\t+/);
    const nonEmpty = parts.filter(p => p.trim().length > 0);

    if (nonEmpty.length >= 3) {
      const stationName = nonEmpty[0].trim();
      if (stationName.match(/^[A-Za-z\s/]+$/) && stationName.length > 1 &&
          !stationName.toLowerCase().includes("station") &&
          !stationName.toLowerCase().includes("weight") &&
          !stationName.toLowerCase().includes("arm") &&
          !stationName.toLowerCase().includes("moment")) {
        const weight = nonEmpty[1].replace(/,/g, "");
        const arm = nonEmpty.length >= 3 ? nonEmpty[2].replace(/,/g, "") : "";
        const moment = nonEmpty.length >= 4 ? nonEmpty[3].replace(/,/g, "") : "";
        if (parseFloat(weight) > 0) {
          stations.push({ station: stationName, weight, arm, moment });
        }
      }
    }
  }

  if (stations.length === 0 && !seenHeader) {
    const tablePattern = /^\s*([A-Za-z][A-Za-z\s/]{1,40}?)\s{2,}([\d,]+\.?\d*)\s{2,}([\d,]+\.?\d*)\s{2,}([\d,]+\.?\d*)\s*$/gm;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tablePattern.exec(text)) !== null) {
      const name = tableMatch[1].trim();
      const weight = tableMatch[2].replace(/,/g, "");
      const arm = tableMatch[3].replace(/,/g, "");
      const moment = tableMatch[4].replace(/,/g, "");

      if (name.length > 1 && parseFloat(weight) > 0 &&
          !name.toLowerCase().includes("total") &&
          !name.toLowerCase().includes("station") &&
          !name.toLowerCase().includes("weight") &&
          !stations.some(s => s.station === name)) {
        stations.push({ station: name, weight, arm, moment });
      }
    }
  }

  return stations;
}

function extractNumberAfterLabel(line: string, labels: string[], allLines: string[], lineIndex: number): string | null {
  const lineLower = line.toLowerCase();
  for (const label of labels) {
    const idx = lineLower.indexOf(label);
    if (idx === -1) continue;

    const afterLabel = line.substring(idx + label.length);
    const colonIdx = afterLabel.indexOf(":");
    let valuePart: string;
    if (colonIdx >= 0) {
      valuePart = afterLabel.substring(colonIdx + 1).trim();
    } else {
      valuePart = afterLabel.trim();
    }

    const numMatch = valuePart.match(/^[:\s]*([\d,]+(?:\.\d+)?)\s*(lbs?|pounds?|kg|kilograms?)?/i);
    if (numMatch) {
      const num = numMatch[1].replace(/,/g, "");
      const unit = numMatch[2] || "";
      return unit ? `${num} ${unit.toLowerCase().replace(/pounds?/, "lbs").replace(/kilograms?/, "kg")}` : num;
    }

    const valueMatch = valuePart.match(/^[:\s]*([\d,]+(?:\.\d+)?(?:\s*(?:lbs?|pounds?|kg|kilograms?))?)/i);
    if (valueMatch) {
      return valueMatch[1].replace(/,/g, "");
    }
  }
  return null;
}

export async function parseWeightBalance(text: string): Promise<WeightBalanceData> {
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for parsing");
  }

  const deterministic = deterministicParseWeightBalance(text);
  if (deterministic) return deterministic;

  return callLLMWithFallback<WeightBalanceData>(
    SYSTEM_PROMPT,
    `Parse this weight and balance document text:\n\n${text}`,
  );
}

export async function storeWeightBalanceData(
  db: Db,
  documentId: string,
  parsed: WeightBalanceData,
): Promise<void> {
  await db.insert(crewbriefWeightBalance).values({
    documentId,
    tripId: parsed.tripId,
    documentDate: parsed.documentDate ?? null,
    aircraftRegistration: parsed.aircraftRegistration ?? null,
    aircraftType: parsed.aircraftType ?? null,
    basicEmptyWeight: parsed.basicEmptyWeight ?? null,
    basicEmptyWeightCg: parsed.basicEmptyWeightCg ?? null,
    basicEmptyWeightMoment: parsed.basicEmptyWeightMoment ?? null,
    operatingEmptyWeight: parsed.operatingEmptyWeight ?? null,
    operatingEmptyWeightCg: parsed.operatingEmptyWeightCg ?? null,
    operatingEmptyWeightMoment: parsed.operatingEmptyWeightMoment ?? null,
    maxRampWeight: parsed.maxRampWeight ?? null,
    maxTakeoffWeight: parsed.maxTakeoffWeight ?? null,
    maxLandingWeight: parsed.maxLandingWeight ?? null,
    maxZeroFuelWeight: parsed.maxZeroFuelWeight ?? null,
    zeroFuelWeight: parsed.zeroFuelWeight ?? null,
    zeroFuelWeightCg: parsed.zeroFuelWeightCg ?? null,
    zeroFuelWeightMoment: parsed.zeroFuelWeightMoment ?? null,
    rampWeight: parsed.rampWeight ?? null,
    takeoffWeight: parsed.takeoffWeight ?? null,
    takeoffWeightCg: parsed.takeoffWeightCg ?? null,
    takeoffWeightMoment: parsed.takeoffWeightMoment ?? null,
    landingWeight: parsed.landingWeight ?? null,
    landingWeightCg: parsed.landingWeightCg ?? null,
    landingWeightMoment: parsed.landingWeightMoment ?? null,
    fuelUnit: parsed.fuelUnit ?? null,
    fuelRamp: parsed.fuelRamp ?? null,
    fuelTrip: parsed.fuelTrip ?? null,
    fuelContingency: parsed.fuelContingency ?? null,
    fuelAlternate: parsed.fuelAlternate ?? null,
    fuelFinalReserve: parsed.fuelFinalReserve ?? null,
    fuelTaxi: parsed.fuelTaxi ?? null,
    payload: parsed.payload ?? null,
    passengerCount: parsed.passengerCount ?? null,
    passengerWeight: parsed.passengerWeight ?? null,
    cargoWeight: parsed.cargoWeight ?? null,
    baggageWeight: parsed.baggageWeight ?? null,
    crewCount: parsed.crewCount ?? null,
    crewWeight: parsed.crewWeight ?? null,
    stations: parsed.stations ? sql`${JSON.stringify(parsed.stations)}::jsonb` : null,
    rawExtraction: sql`${JSON.stringify(parsed)}::jsonb`,
  });
}
