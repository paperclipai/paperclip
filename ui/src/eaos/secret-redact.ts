// LET-467 — read-only redaction helper for the EAOS Mission detail surfaces.
//
// Mirrors the pattern used in `IssueMissionControlPanel.redactSecretLikeText`:
// strip Bearer tokens, common credential assignments, and Telegram-style
// bot tokens before we render evidence/replay text. The Mission detail slice
// renders comment bodies, validator notes, run errors, and final-delivery
// summaries that all flow through `safeDisplayText`, so a single helper keeps
// the redaction contract consistent across panels.
//
// This is intentionally a strict superset of the sweep regexes in
// `secret-safety.ts` — that module is used to *fail* tests if a secret leaks
// into a static label; this one is used to *mask* a secret in user-visible
// text without blocking the render.

export function redactSecretLikeText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._:-]+/gi, "Bearer [REDACTED]")
    .replace(
      /(authorization|api[_-]?key|token|password|secret|client[_-]?secret|access[_-]?token)(\s*[:=]\s*)(["']?)[^\s"',;)]+/gi,
      "$1$2$3[REDACTED]",
    )
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot[REDACTED]")
    .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}\b/gi, "sk-[REDACTED]")
    .replace(/\bgh[opus]_[A-Za-z0-9]{20,}\b/g, "gh_[REDACTED]")
    .replace(/\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g, "xox-[REDACTED]");
}

export function truncateText(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function safeDisplayText(text: string | null | undefined, max = 240): string | null {
  if (!text) return null;
  return truncateText(redactSecretLikeText(text), max);
}
