import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readConfigFile } from "../config-file.js";

const require = createRequire(import.meta.url);

export interface BriefingStation {
  icao?: string;
  name?: string;
  metar?: string;
  taf?: string;
}

export interface FuelInfo {
  plan?: string;
  unit?: string;
  taxi?: string;
  trip?: string;
  contingency?: string;
  alternate?: string;
  finalReserve?: string;
}

export interface BriefingNotam {
  id?: string;
  location?: string;
  type?: string;
  description?: string;
  effective?: string;
  until?: string;
}

export interface BriefingCrewAlert {
  type: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "critical";
}

export interface BriefingCrewMember {
  name: string;
  position: string;
}

export interface ParsedFlightBriefing {
  tripId: string;
  airline?: string;
  flightNumber?: string;
  departure: BriefingStation;
  arrival: BriefingStation;
  alternate?: BriefingStation;
  route?: string;
  filedAltitude?: string;
  estimatedTimeEnroute?: string;
  fuel?: FuelInfo;
  notams: BriefingNotam[];
  crewAlerts?: BriefingCrewAlert[];
  aircraftRegistration?: string;
  aircraftType?: string;
  crew?: BriefingCrewMember[];
  generatedAt?: string;
  briefingSource?: string;
}

export interface BriefingExtractionSummary {
  tripId: string;
  departure: string | null;
  arrival: string | null;
  alternate: string | null;
  notamCount: number;
  alertCount: number;
  crewCount: number;
  hasRouteInfo: boolean;
  hasFuelInfo: boolean;
  hasWeather: boolean;
}

const SYSTEM_PROMPT = `You are JetInsight, an aviation flight briefing parser. Extract structured flight briefing data from the provided raw text extracted from a flight briefing PDF.

Return ONLY a JSON object matching this exact structure:
{
  "tripId": "unique identifier — use flight number + date, or tail number + date, or generate one",
  "airline": "airline name or ICAO code if mentioned",
  "flightNumber": "e.g. AA1234",
  "departure": {
    "icao": "departure airport ICAO code",
    "name": "airport name if available",
    "metar": "full METAR text for departure airport if present",
    "taf": "full TAF text for departure airport if present"
  },
  "arrival": {
    "icao": "arrival airport ICAO code",
    "name": "airport name if available",
    "metar": "full METAR text for arrival airport if present",
    "taf": "full TAF text for arrival airport if present"
  },
  "alternate": {
    "icao": "alternate airport ICAO code if mentioned",
    "name": "airport name if available",
    "metar": "full METAR text for alternate if present",
    "taf": "full TAF text for alternate if present"
  },
  "route": "full route string if mentioned (waypoints, airways)",
  "filedAltitude": "e.g. FL350 or 35000 feet",
  "estimatedTimeEnroute": "e.g. 2:30 or 2h30m",
  "fuel": {
    "plan": "total fuel on board",
    "unit": "lbs or kg",
    "taxi": "taxi fuel if mentioned",
    "trip": "trip fuel if mentioned",
    "contingency": "contingency fuel if mentioned",
    "alternate": "alternate fuel if mentioned",
    "finalReserve": "final reserve fuel if mentioned"
  },
  "notams": [
    {
      "id": "NOTAM identifier e.g. D0123/25",
      "location": "affected airport or facility ICAO",
      "type": "NOTAM type (e.g. Airport, Enroute, NAVAID)",
      "description": "full NOTAM text description",
      "effective": "effective date/time",
      "until": "expiration date/time"
    }
  ],
  "crewAlerts": [
    {
      "type": "alert category (e.g. Weather, Fatigue, NOTAM, Delay)",
      "title": "short alert title",
      "description": "detailed description",
      "severity": "info" or "warning" or "critical"
    }
  ],
  "aircraftRegistration": "tail number e.g. N12345",
  "aircraftType": "aircraft type e.g. Boeing 737-800",
  "crew": [
    {
      "name": "crew member name",
      "position": "e.g. Captain, First Officer, Flight Attendant"
    }
  ],
  "generatedAt": "briefing generation timestamp if present",
  "briefingSource": "source system e.g. ForeFlight, Jeppesen, FltPlan.com"
}

Rules:
- Extract ALL NOTAMs mentioned. Include each NOTAM's identifier, location, type, description, and times.
- Extract all weather information including METAR and TAF text. Preserve the raw METAR/TAF codes exactly as they appear.
- For fuel information, capture the numeric values and unit (lbs/kg).
- Extract crew alert items with their severity level.
- If the briefing is for a specific flight, extract the flight number.
- Use ICAO airport codes (KJFK, KLAX, EGLL) when possible.
- If no tripId can be derived, use "BRIEFING-{flightNumber}-{date}".
- If the text does NOT contain flight briefing data, return { "error": "No flight briefing data found in provided text" }
- IMPORTANT: Return valid JSON only, no markdown, no code fences.`;

function resolveOpenAiApiKey(): string | null {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;
  const config = readConfigFile();
  if (config?.llm?.provider !== "openai") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

function resolveAnthropicApiKey(): string | null {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) return envKey;
  const config = readConfigFile();
  if (config?.llm?.provider !== "claude") return null;
  const configKey = config.llm.apiKey?.trim();
  return configKey && configKey.length > 0 ? configKey : null;
}

function determineProvider(): "openai" | "claude" | null {
  if (resolveOpenAiApiKey()) return "openai";
  if (resolveAnthropicApiKey()) return "claude";
  const config = readConfigFile();
  if (config?.llm?.provider === "openai" && config.llm.apiKey) return "openai";
  if (config?.llm?.provider === "claude" && config.llm.apiKey) return "claude";
  return null;
}

async function callOpenAI(text: string): Promise<ParsedFlightBriefing> {
  const apiKey = resolveOpenAiApiKey()!;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Parse this flight briefing text:\n\n${text}` },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as { choices: { message: { content: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned empty response");

  return parseResult(content);
}

async function callClaude(text: string): Promise<ParsedFlightBriefing> {
  const apiKey = resolveAnthropicApiKey()!;
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: `Parse this flight briefing text:\n\n${text}` },
      ],
      temperature: 0.1,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${err}`);
  }

  const data = (await response.json()) as { content: { text: string }[] };
  const contentBlock = data.content?.[0];
  if (!contentBlock?.text) throw new Error("Anthropic returned empty response");

  return parseResult(contentBlock.text);
}

function parseResult(raw: string): ParsedFlightBriefing {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed as ParsedFlightBriefing;
}

const ICAO_PATTERN = /\b[K|C|B|E|L|O|S|U|D|G|H|M|N|P|R|T|V|W|Y|Z][A-Z]{3}\b/;
const NOTAM_PATTERN = /\b([A-Z]\d{4}\/\d{2})\b/;
const METAR_LINE = /^(?:METAR|TAF)\s+(?:COR\s+)?([A-Z]{4})\s/;

export function deterministicParseFlightBriefing(text: string): ParsedFlightBriefing | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 5) return null;

  const result: ParsedFlightBriefing = {
    tripId: "",
    departure: {},
    arrival: {},
    notams: [],
  };

  let foundBriefingIndicators = false;
  const lowerText = text.toLowerCase();

  const hasBriefingIndicators =
    lowerText.includes("briefing") ||
    lowerText.includes("flight planning") ||
    lowerText.includes("notam") ||
    lowerText.includes("metar") ||
    lowerText.includes("taf ") ||
    lowerText.includes("enroute") ||
    lowerText.includes("weather");

  if (!hasBriefingIndicators) return null;

  let currentNotam: Partial<BriefingNotam> | null = null;
  let inNotamSection = false;
  let inWeatherSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = lowerText.split("\n")[i]?.toLowerCase() ?? "";

    if (lower.includes("notam") && (lower.includes("section") || lower.includes("list"))) {
      inNotamSection = true;
      continue;
    }
    if (lower.includes("weather") && (lower.includes("section") || lower.includes("summary"))) {
      inWeatherSection = true;
      inNotamSection = false;
      continue;
    }

    const metarMatch = line.match(METAR_LINE);
    if (metarMatch) {
      const station = metarMatch[1];
      if (line.startsWith("METAR")) {
        if (!result.departure.icao) {
          result.departure.icao = station;
          result.departure.metar = line;
        } else if (station !== result.departure.icao && !result.arrival.icao) {
          result.arrival.icao = station;
          result.arrival.metar = line;
        } else if (station !== result.departure.icao && station !== result.arrival.icao) {
          result.alternate ??= {};
          result.alternate.icao = station;
          result.alternate.metar = line;
        }
      } else if (line.startsWith("TAF")) {
        if (station === result.departure.icao) {
          result.departure.taf = line;
        } else if (station === result.arrival.icao) {
          result.arrival.taf = line;
        } else if (result.alternate?.icao === station) {
          result.alternate.taf = line;
        }
      }
      foundBriefingIndicators = true;
      continue;
    }

    if (lower.includes("flight") && lower.includes(":")) {
      const val = line.split(":")[1]?.trim();
      if (val && !result.flightNumber) {
        result.flightNumber = val;
        foundBriefingIndicators = true;
      }
      continue;
    }

    if (lower.includes("route") && lower.includes(":")) {
      const val = line.split(":")[1]?.trim();
      if (val && val.length > 5) {
        result.route = val;
      }
      continue;
    }

    if (lower.includes("aircraft") || lower.includes("acft") || lower.includes("registration")) {
      const val = line.split(":")[1]?.trim();
      if (val) {
        if (!result.aircraftRegistration) {
          result.aircraftRegistration = val;
        } else if (!result.aircraftType) {
          result.aircraftType = result.aircraftRegistration;
          result.aircraftRegistration = val;
        }
      }
      continue;
    }

    const notamMatch = line.match(NOTAM_PATTERN);
    if (notamMatch && inNotamSection) {
      if (currentNotam?.id) {
        result.notams.push(currentNotam as BriefingNotam);
      }
      currentNotam = { id: notamMatch[1] };
      foundBriefingIndicators = true;
      continue;
    }

    const icaoMatch = line.match(ICAO_PATTERN);
    if (icaoMatch && inWeatherSection) {
      const station = icaoMatch[0];
      if (line.includes("ORIGIN") || line.includes("DEP") || line.includes("FROM")) {
        result.departure.icao = station;
      } else if (line.includes("DEST") || line.includes("ARR") || line.includes("TO")) {
        result.arrival.icao = station;
      } else if (line.includes("ALTN") || line.includes("ALTERNATE")) {
        result.alternate ??= {};
        result.alternate.icao = station;
      }
      foundBriefingIndicators = true;
    }
  }

  if (currentNotam?.id) {
    result.notams.push(currentNotam as BriefingNotam);
  }

  if (!foundBriefingIndicators && result.notams.length === 0 && !result.departure.metar) {
    return null;
  }

  if (!result.tripId) {
    result.tripId = `BRIEFING-${result.flightNumber || "FLT"}-${new Date().toISOString().slice(0, 10)}`;
  }

  return result;
}

export function summarizeBriefing(parsed: ParsedFlightBriefing): BriefingExtractionSummary {
  return {
    tripId: parsed.tripId,
    departure: parsed.departure?.icao ?? null,
    arrival: parsed.arrival?.icao ?? null,
    alternate: parsed.alternate?.icao ?? null,
    notamCount: parsed.notams?.length ?? 0,
    alertCount: parsed.crewAlerts?.length ?? 0,
    crewCount: parsed.crew?.length ?? 0,
    hasRouteInfo: !!parsed.route || !!parsed.filedAltitude || !!parsed.estimatedTimeEnroute,
    hasFuelInfo: !!parsed.fuel?.plan,
    hasWeather: !!(parsed.departure?.metar || parsed.departure?.taf),
  };
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const result = spawnSync("python3", ["-c", `
import sys
from io import BytesIO
from pdfminer.high_level import extract_text
data = sys.stdin.buffer.read()
text = extract_text(BytesIO(data))
sys.stdout.write(text)
`], { input: pdfBuffer, maxBuffer: 50 * 1024 * 1024, timeout: 30000 });

  if (result.error) throw new Error(`PDF extraction subprocess failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`PDF extraction subprocess exited ${result.status}: ${result.stderr.toString().slice(0, 500)}`);

  const text = result.stdout.toString().trim();
  if (!text) throw new Error("PDF text extraction returned empty result");
  return text;
}

export async function parseFlightBriefing(text: string): Promise<ParsedFlightBriefing> {
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for parsing");
  }

  const deterministic = deterministicParseFlightBriefing(text);
  if (deterministic) return deterministic;

  const provider = determineProvider();
  if (!provider) {
    throw new Error(
      "No LLM provider configured and deterministic parsing failed. " +
      "Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable, " +
      "or configure llm.provider and llm.apiKey in your paperclip config.",
    );
  }

  if (provider === "openai") {
    return callOpenAI(text);
  }
  return callClaude(text);
}

import type { ParseInput, ParseResult } from "./crewbrief-document-registry.js";

export async function parseFlightBriefingDocument(input: ParseInput): Promise<ParseResult> {
  try {
    const text = await extractPdfText(input.buffer);
    const parsed = await parseFlightBriefing(text);
    const summary = summarizeBriefing(parsed);
    return {
      success: true,
      summary: {
        ...summary,
        flightNumber: parsed.flightNumber ?? null,
        aircraftRegistration: parsed.aircraftRegistration ?? null,
        aircraftType: parsed.aircraftType ?? null,
        route: parsed.route ?? null,
        filedAltitude: parsed.filedAltitude ?? null,
        estimatedTimeEnroute: parsed.estimatedTimeEnroute ?? null,
        briefingSource: parsed.briefingSource ?? null,
        fuelUnit: parsed.fuel?.unit ?? null,
      } as unknown as Record<string, unknown>,
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown parse error" };
  }
}
