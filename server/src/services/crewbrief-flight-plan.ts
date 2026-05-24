import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readConfigFile } from "../config-file.js";

const require = createRequire(import.meta.url);

export interface ParsedFlightPlan {
  tripId: string;
  flightNumber: string;
  origin: string;
  destination: string;
  alternate?: string;
  aircraftRegistration?: string;
  filedAltitude?: string;
  estimatedTimeEnroute?: string;
  distance?: string;
  fuelPlan?: string;
  fuelUnit?: string;
  flightRules?: string;
  route?: string;
  personsOnBoard?: string;
  equipment?: string;
  wakeTurbulence?: string;
  scheduledDeparture?: string;
  scheduledArrival?: string;
}

const SYSTEM_PROMPT = `You are an aviation flight plan parser. Extract structured flight plan data from the provided raw text. The text is extracted from a PDF containing an ICAO flight plan or a JetInsight flight plan document.

Return ONLY a JSON object matching this exact structure:
{
  "tripId": "unique identifier for the trip (use tail number + date, or flight number + date, or generate one)",
  "flightNumber": "e.g. AA1234 or aircraft identification",
  "origin": "ICAO airport code of departure",
  "destination": "ICAO airport code of destination",
  "alternate": "alternate airport ICAO code if mentioned",
  "aircraftRegistration": "tail number e.g. N12345",
  "filedAltitude": "e.g. FL350 or 35000",
  "estimatedTimeEnroute": "e.g. 2:30 or 2h30m or 0530 (HHMM)",
  "distance": "e.g. 450 NM",
  "fuelPlan": "fuel amount as string",
  "fuelUnit": "lbs or kg",
  "flightRules": "IFR, VFR, or other",
  "route": "route string with waypoints",
  "personsOnBoard": "number of persons on board if mentioned",
  "equipment": "equipment code if mentioned",
  "wakeTurbulence": "wake turbulence category (L, M, H) if mentioned",
  "scheduledDeparture": "estimated off-block time in ISO format or HH:MM local",
  "scheduledArrival": "estimated arrival time in ISO format or HH:MM local"
}

Rules:
- Use ICAO airport codes (KJFK, KLAX, EGLL) when possible.
- For tripId, use the tail number + date, or flight number + date.
- If timezone is not specified, assume local time at the origin airport.
- When in doubt, include the information as-is rather than omitting it.
- If the text does NOT contain flight plan data, return { "error": "No flight plan data found in provided text" }
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

async function callOpenAI(text: string): Promise<ParsedFlightPlan> {
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
        { role: "user", content: `Parse this flight plan text:\n\n${text}` },
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

async function callClaude(text: string): Promise<ParsedFlightPlan> {
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
        { role: "user", content: `Parse this flight plan text:\n\n${text}` },
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

function parseResult(raw: string): ParsedFlightPlan {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed as ParsedFlightPlan;
}

function extractValue(line: string, prefix: string): string | null {
  const idx = line.indexOf(prefix);
  if (idx === -1) return null;
  return line.substring(idx + prefix.length).trim();
}

export function deterministicParse(text: string): ParsedFlightPlan | null {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 3) return null;

  const lowerLines = lines.map((l) => l.toLowerCase());

  const hasFplIndicator = lowerLines.some(
    (l) => l.includes("fpl") || l.includes("flight plan") || l.includes("flightplan"),
  );
  const hasFlightIndicators = lowerLines.some(
    (l) => (l.includes("acid") || l.includes("dep") || l.includes("dest") || l.includes("route")),
  );
  if (!hasFplIndicator && !hasFlightIndicators) return null;

  let tripId = "";
  const result: ParsedFlightPlan = {
    tripId: "",
    flightNumber: "",
    origin: "",
    destination: "",
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = lowerLines[i];

    if (lower.includes("fpl")) {
      continue;
    }

    const acidVal = extractValue(line, "ACID:") || extractValue(line, "ACID :") || extractValue(line, "AIRCRAFT ID:");
    if (acidVal) { result.flightNumber = acidVal; continue; }

    const depVal = extractValue(line, "DEP:") || extractValue(line, "DEP :") || extractValue(line, "DEPARTURE:");
    if (depVal) { result.origin = depVal; continue; }

    const destVal = extractValue(line, "DEST:") || extractValue(line, "DEST :") || extractValue(line, "DESTINATION:");
    if (destVal) { result.destination = destVal; continue; }

    const altnVal = extractValue(line, "ALTN:") || extractValue(line, "ALTN :") || extractValue(line, "ALTERNATE:");
    if (altnVal) { result.alternate = altnVal; continue; }

    const altVal = extractValue(line, "CRZLVL:") || extractValue(line, "CRZ LEVEL:") || extractValue(line, "ALTITUDE:") || extractValue(line, "FL:");
    if (altVal) { result.filedAltitude = altVal; continue; }

    const eetVal = extractValue(line, "EET:") || extractValue(line, "EET :") || extractValue(line, "TOTAL EET:") || extractValue(line, "ETE:");
    if (eetVal) { result.estimatedTimeEnroute = eetVal; continue; }

    const distVal = extractValue(line, "DISTANCE:") || extractValue(line, "DIST:") || extractValue(line, "DISTANCE :");
    if (distVal) { result.distance = distVal; continue; }

    const fuelVal = extractValue(line, "FUEL:") || extractValue(line, "FOB:") || extractValue(line, "ENDURANCE:");
    if (fuelVal) {
      const parts = fuelVal.split(/\s+/);
      result.fuelPlan = parts[0];
      result.fuelUnit = parts[1]?.toLowerCase() === "kg" ? "kg" : "lbs";
      continue;
    }

    const routeVal = extractValue(line, "ROUTE:") || extractValue(line, "ROUTE :");
    if (routeVal) { result.route = routeVal; continue; }

    const rulesVal = extractValue(line, "FFR:") || extractValue(line, "FLIGHT RULES:") || extractValue(line, "RULES:");
    if (rulesVal) { result.flightRules = rulesVal; continue; }

    const wtcVal = extractValue(line, "WTC:") || extractValue(line, "WAKE TURB:");
    if (wtcVal) { result.wakeTurbulence = wtcVal; continue; }

    const eqptVal = extractValue(line, "EQPT:") || extractValue(line, "EQUIPMENT:");
    if (eqptVal) { result.equipment = eqptVal; continue; }

    const pobVal = extractValue(line, "POB:") || extractValue(line, "PERSONS:");
    if (pobVal) { result.personsOnBoard = pobVal; continue; }

    const eobtVal = extractValue(line, "EOBT:") || extractValue(line, "EOBT :") || extractValue(line, "OFF BLOCK:");
    if (eobtVal) { result.scheduledDeparture = eobtVal; continue; }

    const acVal = extractValue(line, "ACFT:") || extractValue(line, "AIRCRAFT:") || extractValue(line, "REG:");
    if (acVal) { result.aircraftRegistration = acVal; continue; }
  }

  const hasRequiredFields = result.flightNumber && result.origin && result.destination;
  if (!hasRequiredFields) return null;

  if (!tripId) {
    result.tripId = `${result.flightNumber}-${new Date().toISOString().slice(0, 10)}`;
  } else {
    result.tripId = tripId;
  }

  return result;
}

export async function parseFlightPlan(text: string): Promise<ParsedFlightPlan> {
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
