export function sanitizeRuntimeServiceBaseEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  // These origin settings belong to the parent instance. Letting them leak into a
  // managed worktree runtime can send auth cookies and OAuth callbacks to the wrong
  // Paperclip instance. Runtime/service overrides are merged back after sanitizing.
  delete env.BETTER_AUTH_URL;
  delete env.BETTER_AUTH_BASE_URL;
  delete env.DATABASE_URL;
  delete env.npm_config_tailscale_auth;
  delete env.npm_config_authenticated_private;
  return env;
}
