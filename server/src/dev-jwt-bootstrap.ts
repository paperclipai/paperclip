import { randomBytes } from "node:crypto";

export type DevAgentJwtSecretSource =
  | "PAPERCLIP_AGENT_JWT_SECRET"
  | "BETTER_AUTH_SECRET";

export type EnsureDevAgentJwtSecretResult =
  | { action: "noop"; source: DevAgentJwtSecretSource; secret: string }
  | { action: "generated"; source: "PAPERCLIP_AGENT_JWT_SECRET"; secret: string };

/**
 * Ensure the local agent JWT signing secret is set in `env`.
 *
 * Reads the two env-var names that `server/src/agent-auth-jwt.ts:jwtConfig()`
 * accepts. If either is set with a non-whitespace value, returns "noop". If
 * both are empty/missing, generates a 32-byte cryptographically-random secret,
 * writes it to `env.PAPERCLIP_AGENT_JWT_SECRET`, and returns "generated".
 *
 * Intended for `pnpm dev` boot — gives contributors a working out-of-the-box
 * setup without requiring `paperclipai onboard` first. Production deployments
 * should always set the secret explicitly via the CLI's onboard flow.
 */
export function ensureDevAgentJwtSecret(
  env: Record<string, string | undefined>,
): EnsureDevAgentJwtSecretResult {
  const existingPaperclip = env.PAPERCLIP_AGENT_JWT_SECRET?.trim();
  if (existingPaperclip && existingPaperclip.length > 0) {
    return {
      action: "noop",
      source: "PAPERCLIP_AGENT_JWT_SECRET",
      secret: existingPaperclip,
    };
  }
  const existingBetterAuth = env.BETTER_AUTH_SECRET?.trim();
  if (existingBetterAuth && existingBetterAuth.length > 0) {
    return {
      action: "noop",
      source: "BETTER_AUTH_SECRET",
      secret: existingBetterAuth,
    };
  }
  const generated = randomBytes(32).toString("base64url");
  env.PAPERCLIP_AGENT_JWT_SECRET = generated;
  return {
    action: "generated",
    source: "PAPERCLIP_AGENT_JWT_SECRET",
    secret: generated,
  };
}
