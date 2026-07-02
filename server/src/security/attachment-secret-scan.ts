const SCAN_PREFIX_BYTES = 256 * 1024;
const ENTROPY_THRESHOLD = 4.5;

// Stage 0 — non-secret allowlist, evaluated BEFORE entropy. Legit public client
// config; must not trip the entropy fallback. Does NOT exempt Stage 1 hard blocks.
const ALLOWLIST: RegExp[] = [
  /AIza[0-9A-Za-z_-]{35}/, // Firebase / Google API key (public)
  /[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com/, // Google OAuth client id (public)
];

// Stage 1 — hard blocks (always reject)
const PEM_PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |ENCRYPTED )?PRIVATE KEY-----/;
const KNOWN_TOKENS: { name: string; re: RegExp }[] = [
  { name: "openrouter", re: /sk-or-v1-[a-f0-9]{64}/ },
  { name: "github_pat_classic", re: /ghp_[A-Za-z0-9]{36}/ },
  { name: "github_pat_fine", re: /github_pat_[A-Za-z0-9_]{22,}/ },
  { name: "anthropic", re: /sk-ant-[a-zA-Z0-9_-]{95}/ },
  { name: "openai_project", re: /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/ },
  { name: "openai", re: /sk-[a-zA-Z0-9]{48}/ },
  { name: "aws_akia", re: /AKIA[A-Z0-9]{16}/ },
  { name: "slack", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws_secret", re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}/i },
];

export type ScanResult = { ok: true } | { ok: false; reason: string };

function isTextLike(buf: Buffer): boolean {
  const slice = buf.subarray(0, Math.min(buf.length, SCAN_PREFIX_BYTES));
  let suspicious = 0;
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i];
    if (c === 0) return false; // NUL → binary, out of scope
    if (c < 0x09 || (c > 0x0d && c < 0x20)) suspicious++; // control chars
  }
  return suspicious / Math.max(slice.length, 1) < 0.1;
}

function isServiceAccountJson(text: string): boolean {
  return (
    /"type"\s*:\s*"service_account"/.test(text) &&
    /"private_key"\s*:/.test(text) &&
    /"private_key_id"\s*:/.test(text)
  );
}

function shannonEntropy(token: string): number {
  const freq = new Map<string, number>();
  for (const ch of token) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / token.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function stripAllowlisted(text: string): string {
  let out = text;
  for (const re of ALLOWLIST) out = out.replace(new RegExp(re, "g"), " ");
  return out;
}

// NEVER returns matched bytes — only a reason code.
export function scanAttachmentForSecrets(buf: Buffer): ScanResult {
  if (!isTextLike(buf)) return { ok: true }; // binary out of scope (residual policy)
  const text = buf.subarray(0, SCAN_PREFIX_BYTES).toString("utf8");

  if (PEM_PRIVATE_KEY.test(text)) return { ok: false, reason: "pem_private_key" };
  if (isServiceAccountJson(text)) return { ok: false, reason: "service_account_key" };
  for (const t of KNOWN_TOKENS) {
    if (t.re.test(text)) return { ok: false, reason: `known_token:${t.name}` };
  }

  const survivors = stripAllowlisted(text);
  for (const token of survivors.split(/[^A-Za-z0-9_\-/+=.]+/)) {
    if (token.length >= 25 && shannonEntropy(token) >= ENTROPY_THRESHOLD) {
      return { ok: false, reason: "high_entropy_token" };
    }
  }
  return { ok: true };
}
