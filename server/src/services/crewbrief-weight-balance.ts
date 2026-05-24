import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readConfigFile } from "../config-file.js";

const require = createRequire(import.meta.url);

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

async function callOpenAI(text: string): Promise<WeightBalanceData> {
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
        { role: "user", content: `Parse this weight and balance document text:\n\n${text}` },
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

async function callClaude(text: string): Promise<WeightBalanceData> {
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
        { role: "user", content: `Parse this weight and balance document text:\n\n${text}` },
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

function parseResult(raw: string): WeightBalanceData {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);

  if (parsed.error) {
    throw new Error(parsed.error);
  }

  return parsed as WeightBalanceData;
}

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
    lowerText.includes("payload");

  if (!hasWbIndicators) return null;

  const result: WeightBalanceData = {
    tripId: `WB-${new Date().toISOString().slice(0, 10)}`,
  };

  const tailMatch = text.match(/\bN\d{1,5}[A-Z]?\b/) || text.match(/\b(C-|[A-Z]{2}-)?[A-Z0-9]{3,6}\b.*(?:tail|acft|aircraft|reg[#:]?)/i);
  if (tailMatch && !tailMatch[0].match(/^\d+(\.\d+)?$/)) {
    if (tailMatch[0].startsWith("N") && tailMatch[0].length > 3) {
      result.aircraftRegistration = tailMatch[0];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = lowerLines[i];

    const lineLower = line.toLowerCase();

    if (lineLower.includes("basic empty weight") || lineLower.includes("bew")) {
      const val = extractNumberAfterLabel(line, ["basic empty weight", "bew"], lines, i);
      if (val) result.basicEmptyWeight = val;
      continue;
    }

    if (lineLower.includes("operating empty weight") || lineLower.includes("oew")) {
      const val = extractNumberAfterLabel(line, ["operating empty weight", "oew"], lines, i);
      if (val) result.operatingEmptyWeight = val;
      continue;
    }

    if (lineLower.includes("max takeoff") || lineLower.includes("mtow") || (lineLower.includes("takeoff") && lineLower.includes("weight") && lineLower.includes("max"))) {
      const val = extractNumberAfterLabel(line, ["max takeoff", "mtow", "maximum takeoff"], lines, i);
      if (val) result.maxTakeoffWeight = val;
      continue;
    }

    if (lineLower.includes("max landing") || lineLower.includes("mlw") || (lineLower.includes("landing") && lineLower.includes("weight") && lineLower.includes("max"))) {
      const val = extractNumberAfterLabel(line, ["max landing", "mlw", "maximum landing"], lines, i);
      if (val) result.maxLandingWeight = val;
      continue;
    }

    if (lineLower.includes("max zero fuel") || lineLower.includes("mzfw") || (lineLower.includes("zero fuel") && lineLower.includes("max"))) {
      const val = extractNumberAfterLabel(line, ["max zero fuel", "mzfw", "maximum zero fuel"], lines, i);
      if (val) result.maxZeroFuelWeight = val;
      continue;
    }

    if (lineLower.includes("zero fuel weight") || (lineLower.includes("zero fuel") && !lineLower.includes("max")) || (lineLower === "zfw")) {
      const val = extractNumberAfterLabel(line, ["zero fuel weight", "zfw"], lines, i);
      if (val) result.zeroFuelWeight = val;
      continue;
    }

    if (lineLower.includes("ramp weight") || lineLower.includes("taxi weight")) {
      const val = extractNumberAfterLabel(line, ["ramp weight", "taxi weight", "ramp"], lines, i);
      if (val) result.rampWeight = val;
      continue;
    }

    if (lineLower.includes("max ramp") || lineLower.includes("maximum ramp")) {
      const val = extractNumberAfterLabel(line, ["max ramp", "maximum ramp"], lines, i);
      if (val) result.maxRampWeight = val;
      continue;
    }

    if ((lineLower.includes("takeoff weight") || lineLower.includes("take-off weight") || lineLower === "tow") && !lineLower.includes("max")) {
      const val = extractNumberAfterLabel(line, ["takeoff weight", "take-off weight", "tow"], lines, i);
      if (val) result.takeoffWeight = val;
      continue;
    }

    if ((lineLower.includes("landing weight") || lineLower === "law") && !lineLower.includes("max")) {
      const val = extractNumberAfterLabel(line, ["landing weight", "law"], lines, i);
      if (val) result.landingWeight = val;
      continue;
    }

    if (lineLower.includes("payload")) {
      const val = extractNumberAfterLabel(line, ["payload"], lines, i);
      if (val) result.payload = val;
      continue;
    }

    if (lineLower.includes("passenger") && (lineLower.includes("count") || lineLower.includes("number") || lineLower.match(/\d+\s*pax/))) {
      const match = line.match(/(\d+)\s*(?:pax|passengers?)/i);
      if (match) result.passengerCount = match[1];
      continue;
    }

    if ((lineLower.includes("total fuel") || lineLower.includes("fuel on board") || lineLower.includes("fob")) && !lineLower.includes("max")) {
      const val = extractNumberAfterLabel(line, ["total fuel", "fuel on board", "fob", "fuel"], lines, i);
      if (val) result.fuelRamp = val;
      continue;
    }

    if (lineLower.includes("trip fuel") || lineLower.includes("burn fuel") || lineLower.includes("fuel burn") || (lineLower.includes("fuel") && lineLower.includes("trip"))) {
      const val = extractNumberAfterLabel(line, ["trip fuel", "fuel burn", "burn fuel"], lines, i);
      if (val) result.fuelTrip = val;
      continue;
    }
  }

  const fuelUnitMatch = text.match(/\b(lbs?|pounds?|kg|kilograms?)\b/i);
  if (fuelUnitMatch) {
    const unit = fuelUnitMatch[1].toLowerCase();
    result.fuelUnit = unit.startsWith("k") ? "kg" : "lbs";
  }

  const typeMatch = text.match(/(?:Aircraft|Type|Model)[:\s]+([A-Za-z0-9\s-]+)/i);
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

export async function parseWeightBalance(text: string): Promise<WeightBalanceData> {
  if (!text || text.trim().length === 0) {
    throw new Error("No text provided for parsing");
  }

  const deterministic = deterministicParseWeightBalance(text);
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
