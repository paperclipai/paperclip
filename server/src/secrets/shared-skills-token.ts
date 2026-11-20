/**
 * Boot-time snapshot of the shared skills read token (TECH-9129), the same early-capture / re-scrub pattern as the
 * platform default keys.
 *
 * - The FIRST capture is the only authoritative source; later values are never adopted.
 * - The token variable is deleted from `env` on EVERY capture call, so default-env children (agent processes) and
 *   later dotenv loads never see it.
 * - Nothing here logs or exposes the value.
 */
export const SHARED_SKILLS_TOKEN_ENV = "PAPERCLIP_SHARED_SKILLS_GITHUB_TOKEN";

let captured: string | null = null;
let didCapture = false;

/** Captures (first call only) and always scrubs the token. Returns only whether one was present. */
export function captureAndScrubSharedSkillsToken(env: NodeJS.ProcessEnv = process.env): { configured: boolean } {
  if (!didCapture) {
    didCapture = true;
    const value = env[SHARED_SKILLS_TOKEN_ENV]?.trim();
    captured = value ? value : null;
  }
  delete env[SHARED_SKILLS_TOKEN_ENV];
  return { configured: captured !== null };
}

/** The boot snapshot (null before any capture; never falls back to reading `process.env`). */
export function readSharedSkillsToken(): string | null {
  return captured;
}

/** Resets the captured state. Strictly for targeted tests. */
export function __resetSharedSkillsTokenForTests(token: string | null = null): void {
  captured = token;
  didCapture = token !== null;
}
