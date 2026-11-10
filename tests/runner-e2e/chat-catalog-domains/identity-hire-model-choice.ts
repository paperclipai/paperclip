import { createHash } from "node:crypto";
import { CHAT_OPENCODE_MODEL } from "../chat-runtime-profile.js";

export const HIRE_ORIGINAL_MODEL = "openrouter/deepseek/deepseek-v4-pro";
export const HIRE_MODEL_METADATA_URL = "https://openrouter.ai/api/v1/models?q=deepseek-v4&output_modalities=text";
const PRICE_FIELDS = ["prompt", "completion", "input_cache_read"] as const;
type PriceField = typeof PRICE_FIELDS[number];
type Rates = Record<PriceField, string>;
interface ModelRecord { id: string; pricing: Record<string, unknown> }
export interface HireModelChoice {
  originalModel: string;
  cheaperModel: typeof CHAT_OPENCODE_MODEL;
  eligibleModels: string[];
  sourceRecords: ModelRecord[];
  targetMaximumRates: Rates;
  originalMinimumRates: Rates;
  targetRateVariants: number;
  originalRateVariants: number;
  units: "USD/token";
  metadataSha256?: string;
  retrievedAt?: string;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function amount(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 48 || !/^\d{1,20}(?:\.\d{1,18})?$/.test(value)) throw new Error("Published model price is missing or unsupported");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
}
function variants(model: ModelRecord): Rates[] {
  const pricing = record(model.pricing);
  if (Object.keys(pricing).filter(key => key !== "overrides").sort().join(",") !== [...PRICE_FIELDS].sort().join(",")) throw new Error("Published ancillary price fields are incompatible");
  const overrides = Object.hasOwn(pricing, "overrides") ? pricing.overrides : [];
  if (!Array.isArray(overrides) || overrides.length > 32) throw new Error("Published rate variants are unsupported");
  const rows = [pricing, ...overrides.map(record)];
  for (const row of rows) {
    if (row !== pricing && Object.keys(row).some(key => ![...PRICE_FIELDS, "utc_days", "utc_start", "utc_end"].includes(key))) throw new Error("Published rate variant fields are unsupported");
    for (const field of PRICE_FIELDS) amount(row[field]);
  }
  return rows.map(row => Object.fromEntries(PRICE_FIELDS.map(field => [field, row[field]])) as Rates);
}
export function proveHireModelChoice(body: unknown, catalog: readonly { id: string }[]): HireModelChoice {
  const data = record(body).data;
  if (!Array.isArray(data) || data.length > 64) throw new Error("Official model metadata is invalid");
  const models = [HIRE_ORIGINAL_MODEL, CHAT_OPENCODE_MODEL].map(nativeId => {
    if (catalog.filter(row => row.id === nativeId).length !== 1) throw new Error("Both proposed models must exist in the actual public OpenRouter catalog");
    const rows = data.filter(row => record(row).id === nativeId.replace(/^openrouter\//, ""));
    if (rows.length !== 1) throw new Error("Official model identity is missing or ambiguous");
    const row = record(rows[0]);
    return { id: String(row.id), pricing: record(row.pricing) };
  });
  const original = variants(models[0]!), target = variants(models[1]!);
  const targetMaximumRates = {} as Rates, originalMinimumRates = {} as Rates;
  for (const field of PRICE_FIELDS) {
    targetMaximumRates[field] = target.map(row => row[field]).reduce((a, b) => amount(a) >= amount(b) ? a : b);
    originalMinimumRates[field] = original.map(row => row[field]).reduce((a, b) => amount(a) <= amount(b) ? a : b);
    if (amount(targetMaximumRates[field]) > amount(originalMinimumRates[field])) throw new Error("The selected model does not dominate every published rate variant");
  }
  if (!["prompt", "completion"].some(field => amount(targetMaximumRates[field as PriceField]) < amount(originalMinimumRates[field as PriceField]))) throw new Error("No strictly cheaper published text rate is proved");
  return { originalModel: HIRE_ORIGINAL_MODEL, cheaperModel: CHAT_OPENCODE_MODEL, eligibleModels: [HIRE_ORIGINAL_MODEL, CHAT_OPENCODE_MODEL], sourceRecords: models,
    targetMaximumRates, originalMinimumRates, targetRateVariants: target.length, originalRateVariants: original.length, units: "USD/token" };
}
export function validHireModelChoice(value: unknown): value is HireModelChoice {
  const choice = record(value);
  try {
    const recomputed = proveHireModelChoice({ data: choice.sourceRecords }, (choice.eligibleModels as string[]).map(id => ({ id })));
    return ["originalModel", "cheaperModel", "eligibleModels", "targetMaximumRates", "originalMinimumRates", "targetRateVariants", "originalRateVariants", "units"].every(key => JSON.stringify(choice[key]) === JSON.stringify(record(recomputed)[key]))
      && typeof choice.metadataSha256 === "string" && /^[a-f0-9]{64}$/.test(choice.metadataSha256)
      && typeof choice.retrievedAt === "string" && Number.isFinite(Date.parse(choice.retrievedAt));
  } catch { return false; }
}
export async function readHireModelChoice(catalog: readonly { id: string }[], fetcher: typeof fetch = fetch): Promise<HireModelChoice> {
  const response = await fetcher(HIRE_MODEL_METADATA_URL, { method: "GET", headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) throw new Error("Official public model metadata could not be read");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512 * 1024) throw new Error("Official model metadata exceeded its read limit");
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  return { ...proveHireModelChoice(JSON.parse(text), catalog), metadataSha256: digest(text), retrievedAt: new Date().toISOString() };
}
