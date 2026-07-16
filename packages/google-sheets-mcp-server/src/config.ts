import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { z } from "zod";

const serviceAccountSchema = z.object({
  client_email: z.string().email(),
  private_key: z.string().min(1),
  project_id: z.string().optional(),
  token_uri: z.string().optional(),
});

export type GoogleSheetsServiceAccount = z.infer<typeof serviceAccountSchema>;

export interface GoogleSheetsMcpConfig {
  serviceAccount: GoogleSheetsServiceAccount;
  allowedSpreadsheetIds: string[];
  secretRedactions: string[];
}

export interface GoogleSheetsMcpHttpConfig {
  mcpConfig: GoogleSheetsMcpConfig;
  port: number;
  host: string;
  token: string | null;
}

export interface GoogleSheetsMcpConfigInput {
  serviceAccountJson?: string | null;
  serviceAccountJsonPath?: string | null;
  allowedSpreadsheetIds?: string | string[] | null;
}

export interface GoogleSheetsMcpHttpConfigInput extends GoogleSheetsMcpConfigInput {
  port?: string | number | null;
  host?: string | null;
  token?: string | null;
}

function parseArgs(argv: string[]): GoogleSheetsMcpConfigInput {
  const input: GoogleSheetsMcpConfigInput = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return next;
    };
    if (arg === "--service-account-json") input.serviceAccountJson = readValue();
    if (arg === "--service-account-json-path") input.serviceAccountJsonPath = readValue();
    if (arg === "--allowed-spreadsheet-ids") input.allowedSpreadsheetIds = readValue();
  }
  return input;
}

function parseAllowedSpreadsheetIds(raw: string | string[] | null | undefined): string[] {
  const values = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\n,]/g);
  const ids = values.map((value) => value.trim()).filter(Boolean);
  return Array.from(new Set(ids));
}

function parsePort(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 8849;
  const port = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${raw}`);
  }
  return port;
}

function normalizeBindHost(raw: string | null | undefined): string {
  return raw?.trim() || "127.0.0.1";
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    return normalized.split(".")[0] === "127";
  }
  return false;
}

function readServiceAccountJson(input: GoogleSheetsMcpConfigInput): { raw: string; source: string } {
  const explicitPath = input.serviceAccountJsonPath?.trim();
  if (explicitPath) {
    return { raw: readFileSync(explicitPath, "utf8"), source: explicitPath };
  }

  const inlineOrPath = input.serviceAccountJson?.trim();
  if (!inlineOrPath) {
    throw new Error(
      "Google Sheets service-account credentials are required. Set GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON or GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH.",
    );
  }

  if (inlineOrPath.startsWith("{")) {
    return { raw: inlineOrPath, source: "inline JSON" };
  }

  return { raw: readFileSync(inlineOrPath, "utf8"), source: inlineOrPath };
}

export function createGoogleSheetsMcpConfig(input: GoogleSheetsMcpConfigInput): GoogleSheetsMcpConfig {
  const allowedSpreadsheetIds = parseAllowedSpreadsheetIds(input.allowedSpreadsheetIds);
  if (allowedSpreadsheetIds.length === 0) {
    throw new Error("At least one allowed spreadsheet ID is required.");
  }

  const { raw, source } = readServiceAccountJson(input);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Google Sheets service-account JSON from ${source}.`);
  }

  const serviceAccount = serviceAccountSchema.parse(parsed);
  return {
    serviceAccount,
    allowedSpreadsheetIds,
    secretRedactions: [
      raw,
      serviceAccount.private_key,
      serviceAccount.client_email,
    ].filter((value) => value.length >= 8),
  };
}

export function createGoogleSheetsMcpHttpConfig(input: GoogleSheetsMcpHttpConfigInput): GoogleSheetsMcpHttpConfig {
  const token = input.token?.trim();
  const host = normalizeBindHost(input.host);
  if (!token && !isLoopbackBindHost(host)) {
    throw new Error("GOOGLE_SHEETS_MCP_TOKEN is required when GOOGLE_SHEETS_MCP_HOST is not loopback.");
  }
  return {
    mcpConfig: createGoogleSheetsMcpConfig(input),
    port: parsePort(input.port),
    host,
    token: token ? token : null,
  };
}

export function readConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): GoogleSheetsMcpConfig {
  const args = parseArgs(argv);
  return createGoogleSheetsMcpConfig({
    serviceAccountJson: args.serviceAccountJson ?? env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON,
    serviceAccountJsonPath: args.serviceAccountJsonPath ?? env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH,
    allowedSpreadsheetIds: args.allowedSpreadsheetIds
      ?? env.GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS
      ?? env.GOOGLE_SHEETS_SPREADSHEET_IDS,
  });
}

export function readHttpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): GoogleSheetsMcpHttpConfig {
  const args = parseArgs(argv);
  return createGoogleSheetsMcpHttpConfig({
    serviceAccountJson: args.serviceAccountJson ?? env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON,
    serviceAccountJsonPath: args.serviceAccountJsonPath ?? env.GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON_PATH,
    allowedSpreadsheetIds: args.allowedSpreadsheetIds
      ?? env.GOOGLE_SHEETS_ALLOWED_SPREADSHEET_IDS
      ?? env.GOOGLE_SHEETS_SPREADSHEET_IDS,
    port: env.PORT ?? env.GOOGLE_SHEETS_MCP_PORT,
    host: env.GOOGLE_SHEETS_MCP_HOST,
    token: env.GOOGLE_SHEETS_MCP_TOKEN,
  });
}
