import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// OpenCode credential preflight
//
// An OpenCode run with no model-provider credential fails with the opaque
// "Unexpected server error. Check server logs for details.", which classifies
// as a transient upstream error and feeds an endless automation retry storm.
// This preflight detects the no-credential state BEFORE launching OpenCode so
// the run can fail fast with the permanent errorCode `inference_auth_invalid`
// (which the heartbeat pauses on).
//
// It must never fail a run that could authenticate: env keys, injected gateway
// providers, host-level `opencode auth login` state, and host config provider
// blocks all count as credentials. When in doubt it reports ready and lets
// OpenCode itself decide (the status quo), mirroring how codex-local's
// credential readiness check treats external overrides as self-managed.
// ---------------------------------------------------------------------------

/**
 * Env keys that satisfy an OpenCode provider credential. OpenCode supports far
 * more providers than the three we surface in our own connect UI, and a user
 * may set any of these directly in `config.env` or the host env. Preflight must
 * recognise every provider OpenCode itself authenticates from an env key, or it
 * false-negatives a valid credential into `inference_auth_invalid` and pauses a
 * runnable agent. Keys mirror the provider env names OpenCode reads (via the
 * Vercel AI SDK / models.dev provider definitions). Base-URL overrides are also
 * listed: a configured OpenAI-compatible endpoint (e.g. a local proxy or an EU
 * gateway) may intentionally require no key, so its presence counts too.
 */
export const OPENCODE_PROVIDER_CREDENTIAL_ENV_KEYS = [
  // Anthropic
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  // OpenAI
  "OPENAI_API_KEY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  // OpenRouter
  "OPENROUTER_API_KEY",
  // Google Gemini
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  // Mistral
  "MISTRAL_API_KEY",
  // Groq
  "GROQ_API_KEY",
  // AWS Bedrock (AWS_SECRET_ACCESS_KEY and a region usually accompany it, but
  // the access-key id is the credential signal we key on).
  "AWS_ACCESS_KEY_ID",
  // Azure OpenAI
  "AZURE_OPENAI_API_KEY",
] as const;

export const OPENCODE_MISSING_CREDENTIAL_MESSAGE =
  "No model provider credential is connected for this agent. Connect a provider key, then resume.";

export interface OpenCodeCredentialPreflight {
  ready: boolean;
  source: "env" | "custom_providers" | "host_config" | "host_auth" | null;
  /** The env key or file path that satisfied the preflight, for run-log diagnostics. */
  detail: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Host path where `opencode auth login` stores credentials. */
export function resolveOpenCodeHostAuthPath(env: Record<string, string>): string {
  const dataHome = nonEmpty(env.XDG_DATA_HOME) ?? path.join(os.homedir(), ".local", "share");
  return path.join(dataHome, "opencode", "auth.json");
}

/** Host path of the user's own opencode config (may carry provider blocks). */
export function resolveOpenCodeHostConfigPath(env: Record<string, string>): string {
  const configHome = nonEmpty(env.XDG_CONFIG_HOME) ?? path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode", "opencode.json");
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function customProvidersConfigured(env: Record<string, string>): boolean {
  const raw = nonEmpty(env.PAPERCLIP_OPENCODE_PROVIDERS);
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) && Object.values(parsed).some(isPlainObject);
  } catch {
    return false;
  }
}

/**
 * Decide whether an OpenCode run launched with `env` has any chance to
 * authenticate against a model provider. Pure over `env` (callers pass the
 * fully-merged run env, process env included) apart from the host filesystem
 * lookups for `opencode auth login` state and the host config.
 */
export async function evaluateOpenCodeCredentialPreflight(input: {
  env: Record<string, string>;
}): Promise<OpenCodeCredentialPreflight> {
  const { env } = input;

  for (const key of OPENCODE_PROVIDER_CREDENTIAL_ENV_KEYS) {
    if (nonEmpty(env[key])) {
      return { ready: true, source: "env", detail: key };
    }
  }

  if (customProvidersConfigured(env)) {
    return { ready: true, source: "custom_providers", detail: "PAPERCLIP_OPENCODE_PROVIDERS" };
  }

  const hostConfigPath = resolveOpenCodeHostConfigPath(env);
  const hostConfig = await readJsonObject(hostConfigPath);
  if (hostConfig && isPlainObject(hostConfig.provider) && Object.keys(hostConfig.provider).length > 0) {
    return { ready: true, source: "host_config", detail: hostConfigPath };
  }

  const hostAuthPath = resolveOpenCodeHostAuthPath(env);
  const hostAuth = await readJsonObject(hostAuthPath);
  if (hostAuth && Object.keys(hostAuth).length > 0) {
    return { ready: true, source: "host_auth", detail: hostAuthPath };
  }

  return { ready: false, source: null, detail: null };
}
