/**
 * Argument parsing and validation for memory upgrade filter subcommand (TECH-8572).
 */

import { isValidUuid, validateDatabaseUrl } from "../server/src/services/company-memory-upgrade/census.js";
import { CompanyMemoryUpgradeError } from "../server/src/services/company-memory-upgrade/types.js";
import {
  hasBooleanFlag,
  parseFlagValue,
  validateNoUnknownFlags,
} from "./memory-upgrade.js";
import {
  ALLOWED_FILTER_FLAGS,
  BOOLEAN_FILTER_FLAGS,
} from "./memory-upgrade-filter-flags.js";
import { printFilterHelp } from "./memory-upgrade-filter-help.js";

export interface ParsedFilterArgs {
  manifestPath: string;
  jsonlPath: string;
  outputDir: string;
  companyId: string | null;
  agentId: string | null;
  upgradeId: string | null;
  openaiKeyFile: string | null;
  model: string;
  maxCostUsd: number;
  confirm: string | null;
  keepImportKeysPath: string | null;
  controlPlaneUrl: string | null;
  format: "text" | "json";
  isDryRun: boolean;
  allowProd: boolean;
  concurrency: number;
  chatRpm: number;
  chatTpm: number;
}

export function parseFilterArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  _repoRoot: string = process.cwd(),
): ParsedFilterArgs | { exitCode: number } {
  validateNoUnknownFlags(argv, ALLOWED_FILTER_FLAGS, "filter", BOOLEAN_FILTER_FLAGS);

  if (hasBooleanFlag("--help", argv) || hasBooleanFlag("-h", argv)) {
    printFilterHelp();
    return { exitCode: 0 };
  }

  const manifestPath = parseFlagValue("--manifest", argv);
  if (!manifestPath) {
    console.error("Error: Flag --manifest <path> is required for filter.");
    return { exitCode: 1 };
  }

  const jsonlPath = parseFlagValue("--jsonl", argv);
  if (!jsonlPath) {
    console.error("Error: Flag --jsonl <path> is required for filter.");
    return { exitCode: 1 };
  }

  const outputDir = parseFlagValue("--output-dir", argv);

  const rawConfirm = parseFlagValue("--confirm", argv);
  const confirm = rawConfirm ? rawConfirm.trim().toLowerCase() : null;
  if (confirm && !isValidUuid(confirm)) {
    console.error("Error: Invalid --confirm. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  const rawCompanyId = parseFlagValue("--company", argv);
  const companyId = rawCompanyId ? rawCompanyId.trim().toLowerCase() : null;
  if (companyId && !isValidUuid(companyId)) {
    console.error("Error: Invalid --company. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  if (confirm && companyId && confirm !== companyId) {
    throw new CompanyMemoryUpgradeError(
      "Flag --confirm <uuid> must strictly match --company <uuid>.",
      "INVALID_ARGUMENT",
    );
  }

  if (confirm && !outputDir) {
    throw new CompanyMemoryUpgradeError(
      "Flag --output-dir is required when --confirm is supplied.",
      "INVALID_ARGUMENT",
    );
  }

  const rawAgentId = parseFlagValue("--agent", argv);
  const agentId = rawAgentId ? rawAgentId.trim().toLowerCase() : null;
  if (agentId && !isValidUuid(agentId)) {
    console.error("Error: Invalid --agent. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  const rawUpgradeId = parseFlagValue("--upgrade-id", argv);
  const upgradeId = rawUpgradeId ? rawUpgradeId.trim().toLowerCase() : null;
  if (upgradeId && !isValidUuid(upgradeId)) {
    console.error("Error: Invalid --upgrade-id. Must be a valid UUID.");
    return { exitCode: 1 };
  }

  const model = parseFlagValue("--model", argv) ?? "gpt-5.4-mini";
  if (model !== "gpt-5.4-mini") {
    throw new CompanyMemoryUpgradeError(
      "Invalid --model. Only 'gpt-5.4-mini' is supported.",
      "INVALID_ARGUMENT",
    );
  }

  const rawMaxCostUsd = parseFlagValue("--max-cost-usd", argv);
  let maxCostUsd = 2;
  if (rawMaxCostUsd !== null) {
    const parsedNum = parseFloat(rawMaxCostUsd);
    if (!Number.isFinite(parsedNum) || parsedNum <= 0) {
      throw new CompanyMemoryUpgradeError(
        "Flag '--max-cost-usd' requires a positive number value.",
        "INVALID_ARGUMENT",
      );
    }
    maxCostUsd = parsedNum;
  }

  const rawConcurrency = parseFlagValue("--concurrency", argv);
  let concurrency = 4;
  if (rawConcurrency !== null) {
    const num = parseInt(rawConcurrency, 10);
    if (!Number.isInteger(num) || num < 1 || num > 16 || String(num) !== rawConcurrency.trim()) {
      throw new CompanyMemoryUpgradeError(
        "Invalid --concurrency. Must be an integer between 1 and 16.",
        "INVALID_ARGUMENT",
      );
    }
    concurrency = num;
  }

  const rawChatRpm = parseFlagValue("--chat-rpm", argv);
  let chatRpm = 500;
  if (rawChatRpm !== null) {
    const num = parseInt(rawChatRpm, 10);
    if (!Number.isInteger(num) || num <= 0 || String(num) !== rawChatRpm.trim()) {
      throw new CompanyMemoryUpgradeError(
        "Flag '--chat-rpm' requires a positive integer value.",
        "INVALID_ARGUMENT",
      );
    }
    chatRpm = num;
  }

  const rawChatTpm = parseFlagValue("--chat-tpm", argv);
  let chatTpm = 200_000;
  if (rawChatTpm !== null) {
    const num = parseInt(rawChatTpm, 10);
    if (!Number.isInteger(num) || num <= 0 || String(num) !== rawChatTpm.trim()) {
      throw new CompanyMemoryUpgradeError(
        "Flag '--chat-tpm' requires a positive integer value.",
        "INVALID_ARGUMENT",
      );
    }
    chatTpm = num;
  }

  const openaiKeyFile = parseFlagValue("--openai-key-file", argv);
  const keepImportKeysPath = parseFlagValue("--keep-import-keys", argv);

  const rawFormat = (parseFlagValue("--format", argv) ?? "text").toLowerCase();
  if (rawFormat !== "text" && rawFormat !== "json") {
    console.error(`Error: Invalid --format. Must be "text" or "json".`);
    return { exitCode: 1 };
  }
  const format = rawFormat as "text" | "json";

  const allowProd = hasBooleanFlag("--prod", argv);
  const controlPlaneUrl =
    parseFlagValue("--control-plane-url", argv) ??
    env.CONTROL_PLANE_DATABASE_URL ??
    null;

  if (controlPlaneUrl) {
    validateDatabaseUrl(controlPlaneUrl, env, { allowProd });
  }

  const isDryRunFlag = hasBooleanFlag("--dry-run", argv);
  const isDryRun = isDryRunFlag || !confirm;

  return {
    manifestPath,
    jsonlPath,
    outputDir: outputDir ?? "",
    companyId,
    agentId,
    upgradeId,
    openaiKeyFile,
    model,
    maxCostUsd,
    confirm,
    keepImportKeysPath,
    controlPlaneUrl,
    format,
    isDryRun,
    allowProd,
    concurrency,
    chatRpm,
    chatTpm,
  };
}
