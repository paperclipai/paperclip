// An AWS SigV4 presigned URL is a short-lived capability for one operation on
// one object, which a tool returns on purpose (for example a receipt upload
// link). Its `X-Amz-Credential` (access key ID and scope) and
// `X-Amz-Security-Token` (an STS session token, unusable without the secret
// key) match the secret-name rule, and the unquoted value then hides the rest
// of the URL, so the link cannot be used. Inside a complete SigV4 query only,
// these two parameters are set aside before redaction and put back after it.
// Every other parameter is redacted as before, and a URL that is itself the
// value of a secret-named assignment or option is still hidden whole.
const PRESIGNED_URL_RE = /https:\/\/(?:[^\s"'`<>\\]|\\{1,2}u0026)+/gi;
const PRESIGNED_URL_TRAILING_DELIMITERS_RE = /[)\]}.,;]+$/;
const PRESIGNED_QUERY_SEPARATOR_RE = /(&|\\{1,2}u0026)/i;

const SIGV4_CREDENTIAL_RAW_RE =
  /^X-Amz-Credential=(?:[A-Za-z0-9._~+-]|%(?!2[Ff])[0-9A-Fa-f]{2})+(?:%2F|\/)\d{8}(?:%2F|\/)[A-Za-z0-9_-]+(?:%2F|\/)[A-Za-z0-9_-]+(?:%2F|\/)aws4_request$/i;
const SIGV4_CREDENTIAL_DECODED_VALUE_RE =
  /^[A-Za-z0-9._~+-]+\/\d{8}\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/aws4_request$/i;
const SIGV4_SECURITY_TOKEN_RAW_RE =
  /^X-Amz-Security-Token=(?:[A-Za-z0-9+/._~-]|%[0-9A-Fa-f]{2})+=*$/i;
const SIGV4_SECURITY_TOKEN_DECODED_VALUE_RE = /^[A-Za-z0-9+/._~-]+=*$/;

// Private-use placeholders. Text that already contains them is left to the normal rules.
const KEPT_START = String.fromCharCode(0xe000);
const KEPT_END = String.fromCharCode(0xe001);
const KEPT_PLACEHOLDER_RE = new RegExp(`${KEPT_START}(\\d+)${KEPT_END}`, "g");

const MAX_PERCENT_DECODE_PASSES = 4;

function decodeQueryValueVariants(rawValue: string): string[] | null {
  const variants = [rawValue];
  let current = rawValue;
  for (let pass = 0; pass < MAX_PERCENT_DECODE_PASSES; pass += 1) {
    if (!current.includes("%")) return variants;
    let decoded: string;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding fails closed.
      return null;
    }
    if (decoded === current) return variants;
    variants.push(decoded);
    current = decoded;
  }
  // Reject deeply nested percent-encoding so obfuscated values fail closed.
  return current.includes("%") ? null : variants;
}

export function isSigV4PresignedQuery(parameters: string[]): boolean {
  return (
    parameters.some((part) => /^X-Amz-Algorithm=AWS4-HMAC-SHA256$/i.test(part)) &&
    parameters.some((part) => SIGV4_CREDENTIAL_RAW_RE.test(part)) &&
    parameters.some((part) => /^X-Amz-Date=\d{8}T\d{6}Z$/i.test(part)) &&
    parameters.some((part) => /^X-Amz-Expires=\d+$/i.test(part)) &&
    parameters.some((part) => /^X-Amz-SignedHeaders=[^=&\s]+$/i.test(part)) &&
    parameters.some((part) => /^X-Amz-Signature=[0-9a-f]{64}$/i.test(part))
  );
}

function isKeptSigV4Parameter(
  part: string,
  containsSecretToken: (value: string) => boolean,
): boolean {
  const isCredential = SIGV4_CREDENTIAL_RAW_RE.test(part);
  const isSecurityToken = !isCredential && SIGV4_SECURITY_TOKEN_RAW_RE.test(part);
  if (!isCredential && !isSecurityToken) return false;

  const rawValue = part.slice(part.indexOf("=") + 1);
  const variants = decodeQueryValueVariants(rawValue);
  if (!variants) return false;

  const finalDecoded = variants[variants.length - 1];
  const decodedShapeOk = isCredential
    ? SIGV4_CREDENTIAL_DECODED_VALUE_RE.test(finalDecoded)
    : SIGV4_SECURITY_TOKEN_DECODED_VALUE_RE.test(finalDecoded);
  if (!decodedShapeOk) return false;

  return !variants.some(containsSecretToken);
}

function splitPresignedUrlCandidate(match: string) {
  const trailingMatch = PRESIGNED_URL_TRAILING_DELIMITERS_RE.exec(match);
  const trailing = trailingMatch ? trailingMatch[0] : "";
  const url = trailing ? match.slice(0, -trailing.length) : match;
  const queryStart = url.indexOf("?");
  if (queryStart < 0) return null;
  // The capture group keeps each separator at an odd index.
  const parts = url.slice(queryStart + 1).split(PRESIGNED_QUERY_SEPARATOR_RE);
  if (!isSigV4PresignedQuery(parts.filter((_, index) => index % 2 === 0))) {
    return null;
  }
  return { url, queryStart, parts, trailing };
}

export function containsSigV4PresignedUrl(text: string): boolean {
  if (!/X-Amz-Signature=/i.test(text)) return false;
  for (const match of text.matchAll(PRESIGNED_URL_RE)) {
    if (splitPresignedUrlCandidate(match[0]) !== null) return true;
  }
  return false;
}

export function protectSigV4PresignedUrlParameters(
  text: string,
  containsSecretToken: (value: string) => boolean,
): { text: string; restore: (redacted: string) => string } {
  if (
    !/X-Amz-Signature=/i.test(text) ||
    text.includes(KEPT_START) ||
    text.includes(KEPT_END)
  ) {
    return { text, restore: (redacted) => redacted };
  }
  const kept: string[] = [];
  const protectedText = text.replace(PRESIGNED_URL_RE, (match) => {
    const parsed = splitPresignedUrlCandidate(match);
    if (!parsed) return match;
    const { url, queryStart, parts, trailing } = parsed;
    return (
      url.slice(0, queryStart + 1) +
      parts
        .map((part, index) =>
          index % 2 === 0 && isKeptSigV4Parameter(part, containsSecretToken)
            ? `${KEPT_START}${kept.push(part) - 1}${KEPT_END}`
            : part,
        )
        .join("") +
      trailing
    );
  });
  return {
    text: protectedText,
    restore: (redacted) =>
      kept.length === 0
        ? redacted
        : redacted.replace(
            KEPT_PLACEHOLDER_RE,
            (match, index: string) => kept[Number(index)] ?? match,
          ),
  };
}
