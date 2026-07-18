/**
 * Server-only secrets must never reach agent child processes, but the acpx
 * agent spawn path builds its child environment from a raw `{ ...process.env }`
 * that Paperclip's explicit env overlay can only add to, never subtract from.
 * The same is true for board-chat and workspace lifecycle commands. The single
 * choke point that covers every spawn family is the server's own environment:
 * capture the secrets into module state during startup, then delete them from
 * `process.env` before any agent run can spawn (ETR-35: agents could read
 * PAPERCLIP_AGENT_JWT_SECRET from their run env and mint arbitrary tokens).
 *
 * Server code must read these values via `readServerOnlySecret` instead of
 * `process.env`. The `process.env` fallback keeps CLI entrypoints and unit
 * tests working when the startup scrub has not run in-process.
 */

export const SERVER_ONLY_SECRET_ENV_KEYS = [
  "PAPERCLIP_AGENT_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
] as const;

export type ServerOnlySecretEnvKey = (typeof SERVER_ONLY_SECRET_ENV_KEYS)[number];

const captured = new Map<ServerOnlySecretEnvKey, string>();

export function scrubServerOnlySecretsFromProcessEnv(): void {
  for (const key of SERVER_ONLY_SECRET_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0 && !captured.has(key)) {
      captured.set(key, value);
    }
    delete process.env[key];
  }
}

export function readServerOnlySecret(key: ServerOnlySecretEnvKey): string | undefined {
  return captured.get(key) ?? process.env[key];
}

export function __resetServerOnlySecretCaptureForTests(): void {
  captured.clear();
}
