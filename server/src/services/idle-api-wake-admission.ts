import { createHash } from "node:crypto";

export type ApiWakeClaim = { generation: string; fingerprint: string };
export interface ApiWakeAdmission {
  version: 1;
  stackId: string;
  ownerId: string;
  capabilityGeneration: string;
  challenge: string;
  generation: string;
  keys: { fingerprint: string; expiresAt: string | null }[];
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const generation = (value: Omit<ApiWakeAdmission, "generation">) => createHash("sha256").update(JSON.stringify([
  "paperclip-api-wake-receipt-v1", value.version, value.stackId, value.ownerId, value.capabilityGeneration, value.challenge,
  value.keys.map(key => [key.fingerprint, key.expiresAt]),
])).digest("hex");
export function apiWakeFingerprint(input: { stackId: string; ownerId: string; challenge: string; keyHash: string }): string {
  if (!digest(input.keyHash) || !digest(input.challenge)) throw new Error("Invalid API wake fingerprint input");
  return createHash("sha256").update(JSON.stringify(["paperclip-api-wake-v1", input.stackId, input.ownerId, input.challenge, input.keyHash])).digest("hex");
}
/** Strict bounded canonical wire contract. Parsing never grants tenant permissions. */
export function parseApiWakeAdmission(value: unknown): ApiWakeAdmission {
  if (!object(value) || !exact(value, ["version", "stackId", "ownerId", "capabilityGeneration", "challenge", "generation", "keys"])
    || value.version !== 1 || typeof value.stackId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value.stackId)
    || typeof value.ownerId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.ownerId)
    || !digest(value.capabilityGeneration) || !digest(value.challenge) || !digest(value.generation)
    || !Array.isArray(value.keys) || value.keys.length > 1000) throw new Error("Invalid API wake receipt");
  let previous = "";
  for (const key of value.keys) {
    if (!object(key) || !exact(key, ["fingerprint", "expiresAt"]) || !digest(key.fingerprint) || key.fingerprint <= previous
      || !(key.expiresAt === null || typeof key.expiresAt === "string" && key.expiresAt.length <= 30 && Number.isFinite(Date.parse(key.expiresAt))
        && new Date(key.expiresAt).toISOString() === key.expiresAt)) throw new Error("Invalid API wake receipt key");
    previous = key.fingerprint;
  }
  const parsed = value as unknown as ApiWakeAdmission;
  if (generation(parsed) !== parsed.generation) throw new Error("API wake receipt generation changed");
  return { version: 1, stackId: parsed.stackId, ownerId: parsed.ownerId, capabilityGeneration: parsed.capabilityGeneration,
    challenge: parsed.challenge, generation: parsed.generation,
    keys: parsed.keys.map(key => ({ fingerprint: key.fingerprint, expiresAt: key.expiresAt })) };
}
export function createApiWakeAdmission(input: Omit<ApiWakeAdmission, "version" | "generation">): ApiWakeAdmission {
  const canonical = { version: 1 as const, ...input, keys: [...input.keys].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)) };
  return parseApiWakeAdmission({ ...canonical, generation: generation(canonical) });
}
export function authorizeApiWakeAdmission(receipt: ApiWakeAdmission, input: { stackId: string; token: string; now: number }): ApiWakeClaim | undefined {
  if (receipt.stackId !== input.stackId || input.token.length < 1 || input.token.length > 8192 || /\s/.test(input.token)) return;
  const fingerprint = apiWakeFingerprint({ ...receipt, keyHash: createHash("sha256").update(input.token).digest("hex") });
  return receipt.keys.some(key => key.fingerprint === fingerprint && (key.expiresAt === null || Date.parse(key.expiresAt) > input.now))
    ? { generation: receipt.generation, fingerprint } : undefined;
}
export function matchesApiWakeAdmission(receipt: ApiWakeAdmission, input: { stackId: string; token: string; now: number }): boolean {
  return authorizeApiWakeAdmission(receipt, input) !== undefined;
}
