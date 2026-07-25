const REMOTE_EXECUTION_INHERITED_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GEMINI_BASE_URL",
  "NINEROUTER_API_KEY",
  "NINEROUTER_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "XAI_API_KEY",
]);

function readEnvValueCaseInsensitive(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const direct = env[key];
  if (typeof direct === "string") return direct;
  const upper = key.toUpperCase();
  for (const [candidateKey, candidateValue] of Object.entries(env)) {
    if (candidateKey.toUpperCase() === upper && typeof candidateValue === "string") {
      return candidateValue;
    }
  }
  return undefined;
}

export function sanitizeRemoteExecutionEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const inheritedValue = readEnvValueCaseInsensitive(inheritedEnv, key);
    if (typeof inheritedValue !== "string" || inheritedValue !== value) {
      sanitized[key] = value;
      continue;
    }
    if (REMOTE_EXECUTION_INHERITED_ENV_ALLOWLIST.has(key.toUpperCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
