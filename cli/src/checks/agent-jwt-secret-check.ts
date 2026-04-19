import {
  ensureAgentJwtSecret,
  readAgentJwtSecretFromEnv,
  readAgentJwtSecretFromEnvFile,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import type { CheckResult } from "./index.js";

export function agentJwtSecretCheck(configPath?: string): CheckResult {
  if (readAgentJwtSecretFromEnv(configPath)) {
    return {
      name: "Agent JWT secret",
      status: "pass",
      message: "PAPERCLIP_AGENT_JWT_SECRET is set in environment",
    };
  }

  const envPath = resolveAgentJwtEnvFile(configPath);
  const fileSecret = readAgentJwtSecretFromEnvFile(envPath);

  if (fileSecret) {
    return {
      name: "Agent JWT secret",
      status: "warn",
      message:
        `PAPERCLIP_AGENT_JWT_SECRET is present in ${envPath} but not loaded into environment; ` +
        "local-agent JWT injection will stay disabled until Paperclip is restarted with that env loaded",
      repairHint: `Restart Paperclip through paperclipai run or export the value from ${envPath} before starting the server`,
    };
  }

  return {
    name: "Agent JWT secret",
    status: "fail",
    message: `PAPERCLIP_AGENT_JWT_SECRET missing from environment and ${envPath}`,
    canRepair: true,
    repair: () => {
      ensureAgentJwtSecret(configPath);
    },
    repairHint: `Run with --repair to create ${envPath} containing PAPERCLIP_AGENT_JWT_SECRET`,
  };
}
