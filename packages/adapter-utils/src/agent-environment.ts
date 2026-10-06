// Only host-provided server credentials belong here. Governed agent bindings
// are merged after this filter and can explicitly provide their own values.
const LOCAL_AGENT_SERVER_ONLY_ENV_KEYS = new Set([
  "DATABASE_URL",
  "DATABASE_MIGRATION_URL",
  "PGPASSWORD",
  "PGPASSFILE",
  "POSTGRES_PASSWORD",
  "BETTER_AUTH_SECRET",
  "JWT_SECRET",
  "AUTH_JWT_SECRET",
  "PLUNK_REPORT_TOKEN",
]);

export function sanitizeInheritedPaperclipEnv(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  delete env.PAPERCLIPAI_CMD;
  for (const key of LOCAL_AGENT_SERVER_ONLY_ENV_KEYS) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (!key.startsWith("PAPERCLIP_")) continue;
    if (key === "PAPERCLIP_RUNTIME_API_URL") continue;
    if (key === "PAPERCLIP_LISTEN_HOST") continue;
    if (key === "PAPERCLIP_LISTEN_PORT") continue;
    delete env[key];
  }
  return env;
}

export function buildLocalAgentProcessEnv(
  inheritedEnv: NodeJS.ProcessEnv,
  agentBindings: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...sanitizeInheritedPaperclipEnv(inheritedEnv),
    ...agentBindings,
  };
}
