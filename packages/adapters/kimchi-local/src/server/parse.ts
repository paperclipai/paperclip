/**
 * kimchi_local is ACP-only: the shared acpx engine owns the ACP protocol, so
 * there is no CLI stdout JSON to parse. This module keeps only the failure
 * description helpers shared by the environment test and any future
 * diagnostics surfaces.
 */
function normalizedHaystack(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

export function isKimchiTransientNetworkError(stdout: string, stderr: string): boolean {
  return /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch\s+failed|socket\s+hang\s+up/i.test(
    normalizedHaystack(stdout, stderr),
  );
}

export function describeKimchiFailure(input: {
  errorMessage?: string | null;
  stderr?: string;
}): string | null {
  const detail =
    (typeof input.errorMessage === "string" ? input.errorMessage.trim() : "") ||
    (input.stderr ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ||
    "";
  if (!detail) return null;
  const clean = detail.replace(/\s+/g, " ").trim();
  const max = 240;
  return `Kimchi run failed: ${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}`;
}

const KIMCHI_AUTH_REQUIRED_RE =
  /(?:\bkimchi\s+login\b|\/login\b|login\s+required|not\s+(?:logged\s+in|authenticated)|\b401\b|unauthorized|authentication\s+(?:required|failed)|invalid\s+api[_ ]?key)/i;

export function detectKimchiAuthRequired(input: {
  stdout: string;
  stderr: string;
}): { requiresAuth: boolean } {
  const requiresAuth = normalizedHaystack(input.stdout, input.stderr)
    .split(/\r?\n/)
    .some((line) => KIMCHI_AUTH_REQUIRED_RE.test(line));
  return { requiresAuth };
}
