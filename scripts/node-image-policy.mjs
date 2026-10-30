// Accept the existing major tags and exact patch pins, with a required image variant.
// A digest, when present, must be a complete SHA-256 pin.
export function isNode24ImageTag(tag) {
  const match = /^24(?:\.(0|[1-9]\d*)\.(?:0|[1-9]\d*))?-[a-z0-9][a-z0-9._-]*(?:@sha256:[a-f0-9]{64})?$/.exec(tag);
  // Floating major tags follow Node 24; exact pins must meet engines.node >=24.11.0.
  return match !== null && (match[1] === undefined || BigInt(match[1]) >= 11n);
}
