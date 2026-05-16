export interface TokenIdentity {
  defaultAgentId: string;
  allowedAgentIds: string[];
}

export interface AuthResult {
  ok: boolean;
  identity?: TokenIdentity;
  reason?: string;
}

export function authenticate(
  header: string | undefined,
  tokens: Record<string, TokenIdentity>,
): AuthResult {
  if (!header) return { ok: false, reason: "missing Authorization header" };
  const m = header.match(/^Bearer\s+(.+)$/);
  if (!m) return { ok: false, reason: "Authorization header must be Bearer" };
  const token = m[1]!.trim();
  const identity = tokens[token];
  if (!identity) return { ok: false, reason: "unknown bearer token" };
  return { ok: true, identity };
}

function parseAllowlist(env: string | undefined): string[] {
  if (!env) return [];
  return env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function loadTokensFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, TokenIdentity> {
  const tokens: Record<string, TokenIdentity> = {};

  if (env.BRAIN_PAPERCLIP_TOKEN) {
    const defaultAgentId = "PAPERCLIP";
    const extra = parseAllowlist(env.BRAIN_PAPERCLIP_ALLOWED_AGENTS);
    const allowedAgentIds = Array.from(new Set([defaultAgentId, ...extra]));
    tokens[env.BRAIN_PAPERCLIP_TOKEN] = { defaultAgentId, allowedAgentIds };
  }

  if (env.BRAIN_CLAUDE_CODE_TOKEN) {
    tokens[env.BRAIN_CLAUDE_CODE_TOKEN] = {
      defaultAgentId: "walter",
      allowedAgentIds: ["walter"],
    };
  }

  if (env.BRAIN_N8N_TOKEN) {
    tokens[env.BRAIN_N8N_TOKEN] = {
      defaultAgentId: "n8n",
      allowedAgentIds: ["n8n"],
    };
  }

  return tokens;
}
