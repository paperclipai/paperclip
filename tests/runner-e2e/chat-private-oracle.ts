import { createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
export const CHAT_ORACLE_KEY_ENV = "PAPERCLIP_CHAT_ORACLE_COMMITMENT_KEY";
/** Audited with external owner: these actual private values select expected
 * Notion answers/provider contract. IDs, origins and credential references are
 * provenance, never included. New semantic consumers require an explicit edit. */
export const privateOracleSemanticFields = { notion: ["recentMarker", "olderMarker", "recentFactJson", "olderFactJson", "apiVersion"],agentmail:["recipient"] } as const;
export interface PrivateOracleIdentity { provider: string; fields: string[]; keyIdentity: string; commitment: string }
function readKey(env: NodeJS.ProcessEnv): Buffer {
  const filename = env[CHAT_ORACLE_KEY_ENV]; if (!filename) throw new Error("Private oracle campaign commitment key unavailable");
  let info; try { info = lstatSync(filename); } catch { throw new Error("Private oracle campaign commitment key unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("Private oracle key must be an existing owned0600 regular file");
  let bytes: Buffer; try { bytes = readFileSync(filename); } catch { throw new Error("Private oracle campaign commitment key unavailable"); } if (bytes.length !== 32) throw new Error("Private oracle key must contain exactly32 existing random bytes"); return bytes;
}
export function oracleSemanticFields(provider: string, declaredFields: readonly string[]): string[] {
  const audited = privateOracleSemanticFields[provider as keyof typeof privateOracleSemanticFields] as readonly string[] | undefined;
  return declaredFields.filter(field => audited?.includes(field)).sort();
}
export function privateOracleIdentity(provider: string, declaredFields: readonly string[], prerequisites: Record<string, string>, env: NodeJS.ProcessEnv): PrivateOracleIdentity | undefined {
  const fields = oracleSemanticFields(provider, declaredFields); if (!fields.length) return;
  if (fields.some(field => typeof prerequisites[field] !== "string" || !prerequisites[field]?.trim())) throw new Error("Selected private oracle expectations unavailable");
  const key = readKey(env); const mac = (value: string) => createHmac("sha256", key).update(value).digest("hex");
  return { provider, fields, keyIdentity: mac("paperclip.chat-catalog.oracle-key.v1"),
    commitment: mac(JSON.stringify({ schema: "paperclip.chat-catalog.oracle-expectations.v1", provider, fields: fields.map(field => [field, prerequisites[field]]) })) };
}
/** Host reconciliation must re-read the existing campaign key and actual
 * private expectations. A lost/replaced key or changed oracle input cannot
 * silently authenticate a retained old observation. No key is ever generated. */
export function verifyRetainedPrivateOracle(expected: PrivateOracleIdentity | undefined, provider: string, declaredFields: readonly string[], prerequisites: Record<string, string>, env: NodeJS.ProcessEnv) {
  const current = privateOracleIdentity(provider, declaredFields, prerequisites, env);
  if (!current && !expected) return;
  if (!current || !expected || current.provider !== expected.provider || JSON.stringify(current.fields) !== JSON.stringify(expected.fields)
    || !/^[a-f0-9]{64}$/.test(expected.keyIdentity) || !/^[a-f0-9]{64}$/.test(expected.commitment)
    || !timingSafeEqual(Buffer.from(current.keyIdentity, "hex"), Buffer.from(expected.keyIdentity, "hex")) || !timingSafeEqual(Buffer.from(current.commitment, "hex"), Buffer.from(expected.commitment, "hex"))) throw new Error("Retained private oracle commitment/key mismatch; evidence is ineligible until provenance is resolved");
}
