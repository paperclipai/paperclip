export interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  canRepair?: boolean;
  repair?: () => void | Promise<void>;
  repairHint?: string;
}

export { agentJwtSecretCheck } from "./agent-jwt-secret-check.js";
export { configCheck } from "./config-check.js";
export { deploymentAuthCheck } from "./deployment-auth-check.js";
export { databaseCheck } from "./database-check.js";
export { llmCheck } from "./llm-check.js";
export { logCheck } from "./log-check.js";
export { portCheck } from "./port-check.js";
export { secretsCheck } from "./secrets-check.js";
export { storageCheck } from "./storage-check.js";
