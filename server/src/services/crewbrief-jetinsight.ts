import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readConfigFile } from "../config-file.js";

const require = createRequire(import.meta.url);

export interface ParsedItinerary {
  tripId: string;
  airline?: string;
  startDate?: string;
  endDate?: string;
  legs: {
    legNumber: number;
    flightNumber: string;
    origin: string;
    destination: string;
    alternate?: string;
    scheduledDeparture?: string;
    scheduledArrival?: string;
    aircraftRegistration?: string;
    filedAltitude?: string;
    estimatedTimeEnroute?: string;
    distance?: string;
    fuelPlan?: string;
    fuelUnit?: string;
  }[];
  crewAssignments?: {
    dutyDayId: string;
    employeeId: string;
    dutyDate: string;
    position?: string;
    reportTime?: string;
    releaseTime?: string;
  }[];
}

export interface ExtractionCounts {
  trips: number;
  legs: number;
  crewMembers: number;
  aircraft: number;
  airports: number;
}

const SYSTEM_PROMPT = `You are JetInsight, an aviation crew itinerary parser. Extract structured itinerary data from the provided raw text (email, schedule, manifest, or free-form notes).

Return ONLY a JSON object matching this exact structure:
{
  "tripId": "unique identifier for the trip (use tail number + date, or flight number + date, or generate one)",
  "airline": "airline name or code if mentioned",
  "startDate": "ISO date YYYY-MM-DD of the first duty day",
  "endDate": "ISO date YYYY-MM-DD of the last duty day",
  "legs": [
    {
      "legNumber": 1,
      "flightNumber": "e.g. AA1234",
      "origin": "ICAO or IATA airport code",
      "destination": "ICAO or IATA airport code",
      "alternate": "alternate airport code if mentioned",
      "scheduledDeparture": "departure time in ISO format or HH:MM local",
      "scheduledArrival": "arrival time in ISO format or HH:MM local",
      "aircraftRegistration": "tail number e.g. N12345",
      "filedAltitude": "e.g. FL350 or 35000",
      "estimatedTimeEnroute": "e.g. 2:30 or 2h30m",
      "distance": "e.g. 450 NM",
      "fuelPlan": "fuel amount as string",
      "fuelUnit": "lbs or kg"
    }
  ],
  "crewAssignments": [
    {
      "dutyDayId": "YYYY-MM-DD-{position}",
      "employeeId": "crew member identifier or name",
      "dutyDate": "YYYY-MM-DD",
      "position": "e.g. Captain, First Officer, Flight Attendant",
      "reportTime": "report time in ISO or HH:MM",
      "releaseTime": "release time in ISO or HH:MM"
    }
  ]
}

Rules:
- Extract ALL legs mentioned in order. Assign sequential leg numbers starting at 1.
- Use ICAO codes (KJFK, KLAX, EGLL) when possible, otherwise use IATA.
- For crew assignments, use the person's name as employeeId if no employee ID is given.
- If no airline is mentioned, omit the field.
- If dates are ambiguous, use the most reasonable interpretation.
- If timezone is not specified, assume local time at the origin airport.
- When in doubt, include the information as-is rather than omitting it.
- If the text does NOT contain any flight itinerary data, return { "error": "No itinerary data found in provided text" }
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

async function callOpenAI(text: string): Promise<ParsedItinerary> {
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
        { role: "user", content: `Parse this crew itinerary text:\n\n${text}` },
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

async function callClaude(text: string): Promise<ParsedItinerary> {
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
        { role: "user", content: `Parse this crew itinerary text:\n\n${text}` },
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

function parseResult(raw: string): ParsedItinerary {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed as ParsedItinerary;
}

function parseLine(value: string): string {
  return value.trim();
}

function extractValue(line: string, prefix: string): string | null {
  const idx = line.indexOf(prefix);
  if (idx === -1) return null;
  return line.substring(idx + prefix.length).trim();
}

export function deterministicParse(text: string): ParsedItinerary | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  let tripId = "";
  let airline = "";
  const crewAssignments: ParsedItinerary["crewAssignments"] = [];
  const legs: ParsedItinerary["legs"] = [];
  let currentLeg: Partial<ParsedItinerary["legs"][number]> | null = null;
  let currentCrew: Partial<ParsedItinerary["crewAssignments"][number]> | null = null;
  let inCrewSection = false;
  let inLegSection = false;

  const lowerLines = lines.map((l) => l.toLowerCase());

  const hasFlightIndicators = lowerLines.some(
    (l) => l.includes("flight") || l.includes("origin") || l.includes("destination") || l.includes("aircraft")
  );
  const hasCrewIndicators = lowerLines.some(
    (l) => l.includes("employee") || l.includes("crew") || l.includes("captain") || l.includes("pilot") || l.includes("first officer")
  );
  const hasTripId = lowerLines.some((l) => l.includes("trip") && (l.includes("id") || l.includes("number")));

  if (!hasFlightIndicators && !hasCrewIndicators) return null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = lowerLines[i];

    if (lower.includes("trip") && (lower.includes("id") || lower.includes("number") || lower.includes(":"))) {
      const val = line.split(":")[1]?.trim() || line.split(/\s+/).pop() || "";
      if (val) tripId = val;
      continue;
    }

    if (lower.startsWith("airline") || lower.startsWith("company")) {
      const val = line.split(":")[1]?.trim();
      if (val) airline = val;
      continue;
    }

    if (lower.includes("flight leg") || lower.includes("leg ") || lower.includes("leg:")) {
      if (currentLeg && currentLeg.flightNumber) {
        legs.push(currentLeg as ParsedItinerary["legs"][number]);
      }
      currentLeg = {};
      inLegSection = true;
      inCrewSection = false;
      continue;
    }

    if (lower.includes("crew") && (lower.includes("assign") || lower.includes("member") || lower.includes(":"))) {
      if (currentCrew && currentCrew.employeeId) {
        crewAssignments.push(currentCrew as ParsedItinerary["crewAssignments"][number]);
      }
      currentCrew = {};
      inCrewSection = true;
      inLegSection = false;
      continue;
    }

    if (inLegSection && currentLeg) {
      const flightVal = extractValue(line, "Flight:") || extractValue(line, "Flight :") || extractValue(line, "FLIGHT:");
      if (flightVal) { currentLeg.flightNumber = flightVal; continue; }

      const originVal = extractValue(line, "Origin:") || extractValue(line, "Origin :") || extractValue(line, "ORIGIN:");
      if (originVal) { currentLeg.origin = originVal; continue; }

      const destVal = extractValue(line, "Destination:") || extractValue(line, "Destination :") || extractValue(line, "DESTINATION:");
      if (destVal) { currentLeg.destination = destVal; continue; }

      const altVal = extractValue(line, "Alternate:") || extractValue(line, "Alternate :") || extractValue(line, "ALTN:");
      if (altVal) { currentLeg.alternate = altVal; continue; }

      const acVal = extractValue(line, "Aircraft:") || extractValue(line, "Aircraft :") || extractValue(line, "ACFT:");
      if (acVal) { currentLeg.aircraftRegistration = acVal; continue; }

      const stdVal = extractValue(line, "STD:") || extractValue(line, "STD :") || extractValue(line, "Depart:");
      if (stdVal) { currentLeg.scheduledDeparture = stdVal; continue; }

      const staVal = extractValue(line, "STA:") || extractValue(line, "STA :") || extractValue(line, "Arrive:");
      if (staVal) { currentLeg.scheduledArrival = staVal; continue; }

      const altVal2 = extractValue(line, "Alt:") || extractValue(line, "Altitude:") || extractValue(line, "FL:");
      if (altVal2) { currentLeg.filedAltitude = altVal2; continue; }

      const eteVal = extractValue(line, "ETE:") || extractValue(line, "ETE :") || extractValue(line, "Time Enroute:");
      if (eteVal) { currentLeg.estimatedTimeEnroute = eteVal; continue; }

      const distVal = extractValue(line, "Distance:") || extractValue(line, "Distance :") || extractValue(line, "Dist:");
      if (distVal) { currentLeg.distance = distVal; continue; }

      const fuelVal = extractValue(line, "Fuel:") || extractValue(line, "Fuel :") || extractValue(line, "FOB:");
      if (fuelVal) {
        const parts = fuelVal.split(/\s+/);
        currentLeg.fuelPlan = parts[0];
        currentLeg.fuelUnit = parts[1]?.toLowerCase() === "kg" ? "kg" : "lbs";
        continue;
      }
    }

    if (inCrewSection && currentCrew) {
      const empVal = extractValue(line, "Employee ID:") || extractValue(line, "Employee Id:") || extractValue(line, "ID:") || extractValue(line, "Employee:");
      if (empVal) { currentCrew.employeeId = empVal; continue; }

      const posVal = extractValue(line, "Position:") || extractValue(line, "Position :") || extractValue(line, "Role:");
      if (posVal) { currentCrew.position = posVal; continue; }

      const dutyVal = extractValue(line, "Duty Date:") || extractValue(line, "Duty Date :") || extractValue(line, "Date:");
      if (dutyVal) { currentCrew.dutyDate = dutyVal; continue; }

      const reportVal = extractValue(line, "Report:") || extractValue(line, "Report :") || extractValue(line, "Report Time:");
      if (reportVal) { currentCrew.reportTime = reportVal; continue; }

      const releaseVal = extractValue(line, "Release:") || extractValue(line, "Release :") || extractValue(line, "Release Time:");
      if (releaseVal) { currentCrew.releaseTime = releaseVal; continue; }
    }
  }

  if (currentLeg && currentLeg.flightNumber) {
    legs.push(currentLeg as ParsedItinerary["legs"][number]);
  }
  if (currentCrew && currentCrew.employeeId) {
    crewAssignments.push(currentCrew as ParsedItinerary["crewAssignments"][number]);
  }

  if (legs.length === 0 && crewAssignments.length === 0) return null;

  if (!tripId) {
    tripId = `T-${legs[0]?.flightNumber || "CREW"}-${new Date().toISOString().slice(0, 10)}`;
  }

  const dates = [...new Set(crewAssignments.map((c) => c.dutyDate).filter(Boolean))].sort();
  const startDate = dates[0] || undefined;
  const endDate = dates.length > 1 ? dates[dates.length - 1] : startDate;

  const result: ParsedItinerary = {
    tripId,
    airline: airline || undefined,
    startDate,
    endDate,
    legs: legs.map((leg, idx) => ({
      legNumber: idx + 1,
      flightNumber: leg.flightNumber || "UNKNOWN",
      origin: leg.origin || "",
      destination: leg.destination || "",
      alternate: leg.alternate || undefined,
      scheduledDeparture: leg.scheduledDeparture || undefined,
      scheduledArrival: leg.scheduledArrival || undefined,
      aircraftRegistration: leg.aircraftRegistration || undefined,
      filedAltitude: leg.filedAltitude || undefined,
      estimatedTimeEnroute: leg.estimatedTimeEnroute || undefined,
      distance: leg.distance || undefined,
      fuelPlan: leg.fuelPlan || undefined,
      fuelUnit: leg.fuelUnit || "lbs",
    })),
    crewAssignments: crewAssignments.length > 0
      ? crewAssignments.map((c) => ({
          dutyDayId: c.dutyDate
            ? `${c.dutyDate}-${(c.position || "CREW").toLowerCase().replace(/\s+/g, "-")}`
            : `duty-${c.employeeId}`,
          employeeId: c.employeeId || "UNKNOWN",
          dutyDate: c.dutyDate || startDate || new Date().toISOString().slice(0, 10),
          position: c.position || undefined,
          reportTime: c.reportTime || undefined,
          releaseTime: c.releaseTime || undefined,
        }))
      : undefined,
  };

  return result;
}

export async function parseItinerary(text: string): Promise<ParsedItinerary> {
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for parsing");
  }

  const deterministic = deterministicParse(text);
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

export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const result = spawnSync("python3", ["-c", `
import sys
from pdfminer.high_level import extract_text
sys.stdout.write(extract_text(sys.stdin.buffer))
`], { input: pdfBuffer, maxBuffer: 50 * 1024 * 1024, timeout: 30000 });

  if (result.error) throw new Error(`PDF extraction subprocess failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`PDF extraction subprocess exited ${result.status}: ${result.stderr.toString().slice(0, 500)}`);

  const text = result.stdout.toString().trim();
  if (!text) throw new Error("PDF text extraction returned empty result");
  return text;
}
