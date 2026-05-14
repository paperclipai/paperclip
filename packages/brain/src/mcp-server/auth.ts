export interface AuthResult {
  ok: boolean;
  defaultAgentId?: string;
  reason?: string;
}

export function authenticate(
  header: string | undefined,
  tokens: Record<string, string>,
): AuthResult {
  if (!header) return { ok: false, reason: "missing Authorization header" };
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false, reason: "Authorization header must be Bearer" };
  const token = m[1]!.trim();
  const defaultAgentId = tokens[token];
  if (!defaultAgentId) return { ok: false, reason: "unknown bearer token" };
  return { ok: true, defaultAgentId };
}

export function loadTokensFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const tokens: Record<string, string> = {};
  if (env.BRAIN_PAPERCLIP_TOKEN) tokens[env.BRAIN_PAPERCLIP_TOKEN] = "PAPERCLIP";
  if (env.BRAIN_CLAUDE_CODE_TOKEN) tokens[env.BRAIN_CLAUDE_CODE_TOKEN] = "walter";
  if (env.BRAIN_N8N_TOKEN) tokens[env.BRAIN_N8N_TOKEN] = "n8n";
  return tokens;
}
