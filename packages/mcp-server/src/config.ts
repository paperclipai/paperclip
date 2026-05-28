import { isRunIdParseError, parseOptionalRunId, type RunId } from "@paperclipai/shared";

export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  /**
   * A canonical UUID minted by the Paperclip server. Validated at boot via
   * `parseOptionalRunId(env.PAPERCLIP_RUN_ID, "env")` so that downstream
   * code (every outbound request that sets `X-Paperclip-Run-Id`) can trust
   * the shape. Invalid env throws during `readConfigFromEnv` instead of
   * producing 500s at first mutation.
   */
  runId: RunId | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = nonEmpty(env.PAPERCLIP_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL");
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  const runIdResult = parseOptionalRunId(nonEmpty(env.PAPERCLIP_RUN_ID), "env");
  if (isRunIdParseError(runIdResult)) {
    throw new Error(
      `Invalid PAPERCLIP_RUN_ID: expected canonical UUID, got ${JSON.stringify(runIdResult.got)}`,
    );
  }

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: runIdResult,
  };
}
