import {
  ensureToolActionSigningSecret,
  loadPaperclipEnvFile,
  readPaperclipEnvEntries,
  resolvePaperclipEnvFile,
} from "../config/env.js";
import type { CheckResult } from "./index.js";

const ENV_KEY = "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET";

function isNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function toolActionSigningSecretCheck(configPath?: string): CheckResult {
  loadPaperclipEnvFile(configPath);
  if (isNonEmpty(process.env[ENV_KEY])) {
    return {
      name: "Tool action signing secret",
      status: "pass",
      message: `${ENV_KEY} is set in environment`,
    };
  }

  const envPath = resolvePaperclipEnvFile(configPath);
  if (isNonEmpty(readPaperclipEnvEntries(envPath)[ENV_KEY])) {
    return {
      name: "Tool action signing secret",
      status: "pass",
      message: `${ENV_KEY} is set in ${envPath}`,
    };
  }

  return {
    name: "Tool action signing secret",
    status: "warn",
    message: `${ENV_KEY} missing from environment and ${envPath}; Ask first and approval gates cannot issue signed approvals`,
    canRepair: true,
    repair: () => {
      const { secret } = ensureToolActionSigningSecret(configPath);
      process.env[ENV_KEY] = secret;
    },
    repairHint: `Run with --repair to add ${ENV_KEY} to ${envPath}`,
  };
}
