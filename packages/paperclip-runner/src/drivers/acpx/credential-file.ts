import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

/**
 * Absolute path of an execution-host credential file for the session's ACPX
 * agent. The Runner seeds the agent's isolated provider home from this file
 * and writes fresher refreshed credentials back to it. The provider process
 * never receives this variable or the host path.
 */
export const ACPX_AUTH_JSON_FILE_ENV = "PAPERCLIP_ACPX_AUTH_JSON_FILE";

/** ACPX agents whose subscription login is one `auth.json` document. */
export const ACPX_CREDENTIAL_FILE_AGENTS: readonly QualifiedAcpxAgent[] = ["codex", "grok"];

export function supportsAcpxCredentialFile(agent: QualifiedAcpxAgent): boolean {
  return ACPX_CREDENTIAL_FILE_AGENTS.includes(agent);
}

/**
 * Credential sources that admission counts alongside a host credential file.
 * Launch boundaries check them before filtering the environment, because a
 * filtered-out inline secret would otherwise hide the conflict from staging.
 */
const CONFLICTING_CREDENTIAL_SOURCES: Readonly<Partial<Record<QualifiedAcpxAgent, readonly string[]>>> = {
  codex: ["PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET", "OPENAI_API_KEY", "CODEX_API_KEY"],
  grok: ["PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET", "XAI_API_KEY"],
};

/**
 * Fail closed when a host credential file is supplied for an agent without a
 * file credential, or together with another credential source.
 */
export function assertAcpxCredentialFileAdmissible(
  environment: NodeJS.ProcessEnv | undefined,
  agent: QualifiedAcpxAgent,
): string | undefined {
  const file = acpxCredentialFileSourcePath(environment);
  if (file === undefined) return undefined;
  if (!supportsAcpxCredentialFile(agent)) {
    throw new Error("Managed credential files require the Codex or Grok ACPX profile");
  }
  if ((CONFLICTING_CREDENTIAL_SOURCES[agent] ?? []).some(name => Boolean(environment?.[name]))) {
    throw new Error("Managed credential file source is ambiguous");
  }
  return file;
}

/** An empty value is treated as unset, matching the inline credential variables. */
export function acpxCredentialFileSourcePath(environment: NodeJS.ProcessEnv | undefined): string | undefined {
  const value = environment?.[ACPX_AUTH_JSON_FILE_ENV];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Keep aligned with grok-local's parseGrokAuthPayload / hasUsableGrokAuthValue.
const GROK_IDENTITY_KEY = /^.+::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJsonObject(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} credential is malformed`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} credential is malformed`);
  }
  return value as Record<string, unknown>;
}

const nonEmpty = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

/** Exactly one `<issuer>::<uuid>` entry with a usable key and refresh token. */
export function validateGrokAuthDocument(bytes: Buffer): void {
  const entries = Object.entries(parseJsonObject(bytes, "Grok"));
  const [identity, auth] = entries[0] ?? [];
  if (entries.length !== 1 || !GROK_IDENTITY_KEY.test(identity ?? "") ||
    auth === null || typeof auth !== "object" || Array.isArray(auth) ||
    !nonEmpty((auth as Record<string, unknown>).key) ||
    !nonEmpty((auth as Record<string, unknown>).refresh_token)) {
    throw new Error("Grok credential is malformed");
  }
}

/**
 * Either an API-key document (`OPENAI_API_KEY`) or a subscription document
 * with `tokens.account_id` and token material. Keep aligned with codex-local's
 * hasUsableAuthPayload.
 */
export function validateCodexAuthDocument(bytes: Buffer): void {
  const value = parseJsonObject(bytes, "Codex");
  if (nonEmpty(value.OPENAI_API_KEY)) return;
  const tokens = value.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new Error("Codex credential is malformed");
  }
  const record = tokens as Record<string, unknown>;
  if (!nonEmpty(record.account_id) || !["id_token", "access_token", "refresh_token"].some(key => nonEmpty(record[key]))) {
    throw new Error("Codex credential is malformed");
  }
}
