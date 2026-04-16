/**
 * Secret tokenization.
 *
 * The prompt Claude sees contains opaque tokens like `{{SECRET:DEVTO_PASSWORD}}`.
 * The Paperclip server + adapter never see the resolved value — the token
 * flows through to the sidecar, where `resolveSecretToken` swaps it for the
 * real value just before it hits the keyboard.
 *
 * Why: if the adapter process is compromised or logs leak, resolved secrets
 * are never in its memory. The sidecar is a smaller attack surface (it only
 * drives a browser).
 */

export const SECRET_TOKEN_RE = /\{\{SECRET:([A-Z0-9_]+)\}\}/g;

export interface SecretToken {
  raw: string;
  name: string;
  startIndex: number;
  endIndex: number;
}

export function tokenizeSecrets(input: string): SecretToken[] {
  const tokens: SecretToken[] = [];
  for (const match of input.matchAll(SECRET_TOKEN_RE)) {
    if (match.index === undefined) continue;
    tokens.push({
      raw: match[0],
      name: match[1]!,
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }
  return tokens;
}

export type SecretResolver = (name: string) => Promise<string | null>;

/**
 * Resolve a single secret token. Never logs the resolved value.
 * Returns `null` when the token is unknown — the sidecar MUST refuse to use
 * the input in that case rather than pass through the literal `{{SECRET:*}}`.
 */
export async function resolveSecretToken(
  name: string,
  resolver: SecretResolver,
): Promise<string | null> {
  const value = await resolver(name);
  if (!value) return null;
  return value;
}

/**
 * Replace every `{{SECRET:*}}` in `input` with its resolved value.
 * Returns `{ resolved, unresolved }` so callers can refuse if any token is
 * unknown. Resolved values are returned intact — callers are responsible for
 * not logging them.
 */
export async function resolveAllSecrets(
  input: string,
  resolver: SecretResolver,
): Promise<{ resolved: string; unresolved: string[] }> {
  const tokens = tokenizeSecrets(input);
  if (tokens.length === 0) return { resolved: input, unresolved: [] };

  const unresolved: string[] = [];
  let cursor = 0;
  let out = "";

  for (const token of tokens) {
    const value = await resolveSecretToken(token.name, resolver);
    out += input.slice(cursor, token.startIndex);
    if (value === null) {
      unresolved.push(token.name);
      out += token.raw;
    } else {
      out += value;
    }
    cursor = token.endIndex;
  }
  out += input.slice(cursor);

  return { resolved: out, unresolved };
}
