// Invitation bearer tokens inside free text, such as agent run-log chunks: the
// token segment of a `/invite/<token>` join link and any raw `pcp_invite_`
// token. `stripSecretBearingUrlParts` in redact-sensitive.ts covers whole URL
// values in HTTP log records; this covers the same tokens where they sit
// inside prose or JSON. Both character classes stop at JSON, Markdown, and URL
// delimiters, so the surrounding structure is kept.
//
// Kept in its own module: the chat eval pins the exact bytes of the HTTP log
// redactor (redact-sensitive.ts) before it accepts a real invitation link.
const INVITATION_LINK_TOKEN_TEXT_RE = /(\/invite\/)[A-Za-z0-9_.~%-]+/gi;
const INVITATION_TOKEN_TEXT_RE = /pcp_invite_[A-Za-z0-9_-]+/g;

export function redactInvitationTokens(text: string, marker = "[REDACTED]"): string {
  if (!/\/invite\/|pcp_invite_/i.test(text)) return text;
  return text
    .replace(INVITATION_LINK_TOKEN_TEXT_RE, (_match, prefix: string) => `${prefix}${marker}`)
    .replace(INVITATION_TOKEN_TEXT_RE, () => marker);
}
