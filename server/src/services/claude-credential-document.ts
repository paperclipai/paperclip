// The Claude credential document (`.credentials.json`) that Claude Code
// writes at sign-in and rewrites in place whenever it refreshes the
// short-lived access token. Sign-in stores it, the managed runtime delivers
// it, and the write-back decides whether a refreshed copy may replace it.
// All three read the document through this module so they agree on its shape.

type ClaudeOauthBlock = {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
};

type ParsedDocument = { oauth: ClaudeOauthBlock; root: Record<string, unknown> };

function parseDocument(value: string): ParsedDocument | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const oauth = root.claudeAiOauth;
  if (!oauth || typeof oauth !== "object" || Array.isArray(oauth)) return null;
  return { oauth: oauth as ClaudeOauthBlock, root };
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
// Below this magnitude a numeric expiry is epoch seconds, at or above it epoch
// milliseconds. The same threshold the Codex and Grok predicates use.
const EPOCH_SECONDS_MAX = 1e12;

type Expiry = { present: false } | { present: true; ms: number | null };

// Reads an expiry encoded as ISO-8601, epoch seconds or epoch milliseconds.
// `ms: null` means present but unreadable.
function readExpiry(raw: unknown): Expiry {
  if (raw === undefined || raw === null) return { present: false };
  if (typeof raw === "string") {
    const ms = ISO_8601_RE.test(raw) ? Date.parse(raw) : Number.NaN;
    return { present: true, ms: Number.isFinite(ms) ? ms : null };
  }
  if (typeof raw === "number" && Number.isFinite(raw))
    return { present: true, ms: raw < EPOCH_SECONDS_MAX ? raw * 1000 : raw };
  return { present: true, ms: null };
}

function hasBothTokens(document: ParsedDocument): boolean {
  return nonEmptyString(document.oauth.accessToken) && nonEmptyString(document.oauth.refreshToken);
}

/**
 * A document the CLI can refresh and the write-back can compare: it carries an
 * access token, a refresh token and a readable expiry. A `claude setup-token`
 * credential holds a long-lived access token and no refresh token. It gains
 * nothing from the file, so it stays on `CLAUDE_CODE_OAUTH_TOKEN`, the delivery
 * that token is documented for. A document with no readable expiry stays there
 * too: the write-back could never prove a refreshed copy newer, so the file
 * would freeze at sign-in exactly like the environment variable.
 */
export function isRefreshableClaudeDocument(value: string): boolean {
  const document = parseDocument(value);
  if (!document || !hasBothTokens(document)) return false;
  const expiry = readExpiry(document.oauth.expiresAt);
  return expiry.present && expiry.ms !== null;
}

// Identity fields of the stored document. A refresh keeps the account, so a
// refreshed document must repeat every identity field the stored one carries.
// A missing field counts as a mismatch: the refreshed copy comes from the run's
// own provider home, which the agent process can write, so it must not be able
// to pass the check by leaving the field out.
const IDENTITY_FIELDS: ReadonlyArray<(document: ParsedDocument) => unknown> = [
  (document) => document.oauth.subscriptionType,
  (document) => {
    const account = document.root.account;
    return account && typeof account === "object" && !Array.isArray(account)
      ? (account as { uuid?: unknown }).uuid
      : undefined;
  },
];

function sameIdentity(source: ParsedDocument, destination: ParsedDocument): boolean {
  return IDENTITY_FIELDS.every((read) => {
    const stored = read(destination);
    return !nonEmptyString(stored) || read(source) === stored;
  });
}

// The exit-code contract shared with the Codex and Grok predicates.
/** Replace the stored credential with the refreshed one. */
export const USE_SOURCE = 10;
/** Keep the stored credential. */
export const KEEP_DESTINATION = 20;
/** Keep the stored credential; an expiry was present but unreadable. */
export const UNREADABLE_EXPIRY = 21;
/** Keep the stored credential; the refreshed expiry is implausibly far ahead. */
export const IMPLAUSIBLE_EXPIRY = 22;
export const MAX_PLAUSIBLE_EXPIRY_MS = 400 * 24 * 60 * 60 * 1000;

/**
 * The Claude counterpart of the Codex and Grok write-back predicates, with the
 * same guard order. First match wins:
 *   1. Either side lacks an access token or a refresh token, or the refreshed
 *      document does not repeat an identity field of the stored one
 *      -> KEEP_DESTINATION.
 *   2. Either expiry is absent -> KEEP_DESTINATION.
 *   3. Either expiry is present but unreadable -> UNREADABLE_EXPIRY.
 *   4. The refreshed expiry sits more than MAX_PLAUSIBLE_EXPIRY_MS ahead of
 *      `nowMs` -> IMPLAUSIBLE_EXPIRY. Only the refreshed side is bounded, and
 *      only against the server clock: it comes from the run's own provider
 *      home, so it must never supply the reference time.
 *   5. The refreshed expiry is strictly later -> USE_SOURCE, so a concurrent
 *      run that refreshed afterwards wins.
 *   6. Otherwise (a tie, or the refreshed copy is older) -> KEEP_DESTINATION.
 */
export function decideClaudeAuthMerge(
  refreshed: string,
  stored: string,
  nowMs: number = Date.now(),
): number {
  const source = parseDocument(refreshed);
  const destination = parseDocument(stored);
  if (
    !source ||
    !destination ||
    !hasBothTokens(source) ||
    !hasBothTokens(destination) ||
    !sameIdentity(source, destination)
  )
    return KEEP_DESTINATION;
  const sourceExpiry = readExpiry(source.oauth.expiresAt);
  const destinationExpiry = readExpiry(destination.oauth.expiresAt);
  if (!sourceExpiry.present || !destinationExpiry.present) return KEEP_DESTINATION;
  if (sourceExpiry.ms === null || destinationExpiry.ms === null) return UNREADABLE_EXPIRY;
  if (sourceExpiry.ms - nowMs > MAX_PLAUSIBLE_EXPIRY_MS) return IMPLAUSIBLE_EXPIRY;
  return sourceExpiry.ms > destinationExpiry.ms ? USE_SOURCE : KEEP_DESTINATION;
}
