import { createRequire } from "node:module";
import { readConfigFile } from "../config-file.js";

const require = createRequire(import.meta.url);
const pdfParse: (dataBuffer: Buffer) => Promise<{ text: string; numpages: number }> = require("pdf-parse");

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

export async function parseItinerary(text: string): Promise<ParsedItinerary> {
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for parsing");
  }

  const provider = determineProvider();
  if (!provider) {
    throw new Error(
      "No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY environment variable, " +
        "or configure llm.provider and llm.apiKey in your paperclip config.",
    );
  }

  if (provider === "openai") {
    return callOpenAI(text);
  }
  return callClaude(text);
}

export async function extractPdfText(pdfBuffer: Buffer): Promise<string> {
  const data = await pdfParse(pdfBuffer);
  return data.text;
}
