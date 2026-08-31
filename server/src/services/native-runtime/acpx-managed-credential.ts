import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET =
  "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET" as const;

const MAX_CODEX_AUTH_BYTES = 256 * 1024;

function validCredentialDocument(value: string): boolean {
  if (Buffer.byteLength(value, "utf8") > MAX_CODEX_AUTH_BYTES) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed) && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/**
 * Materialize managed Codex auth for an ACPX sidecar through the process
 * environment. The key is intentionally secret-suffixed so generic
 * environment/log redactors treat the JSON as credential material. The
 * sidecar writes it to its isolated CODEX_HOME and removes it on close.
 */
export function resolveAcpxCodexManagedCredentialEnvironment(
  configured: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const effective = { ...host, ...configured };
  if (effective.OPENAI_API_KEY || effective.CODEX_API_KEY) return {};

  const supplied = configured[PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET];
  if (typeof supplied === "string" && validCredentialDocument(supplied)) {
    return { [PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET]: supplied };
  }

  const explicitHome = effective.CODEX_HOME?.trim();
  const userHome = effective.HOME?.trim();
  const codexHome = explicitHome || (userHome ? resolve(userHome, ".codex") : null);
  if (!codexHome) return {};
  const authPath = join(codexHome, "auth.json");
  try {
    const metadata = statSync(authPath);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_CODEX_AUTH_BYTES) {
      return {};
    }
    const credential = readFileSync(authPath, "utf8");
    return validCredentialDocument(credential)
      ? { [PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET]: credential }
      : {};
  } catch {
    return {};
  }
}
