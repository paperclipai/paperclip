/**
 * Canonical integer parsing for the Tailscale HTTPS broker.
 *
 * The broker treats every value arriving over its Unix socket as untrusted
 * (threat-model verdict PAP-17050, requirement #4: command/process injection and
 * ambient authority). Port numbers are the only numeric arguments the broker
 * ever passes to the `tailscale` CLI, so they must be parsed with zero tolerance
 * for anything that is not a plain, canonical, in-range base-10 integer.
 *
 * Rejected: signs, surrounding/internal whitespace, leading zeros, non-canonical
 * forms, floats, hex/octal/binary prefixes, exponents, Unicode digits, values
 * outside the safe integer range, and non-string/non-number JSON types.
 */

export class InvalidIntegerError extends Error {
  constructor(reason: string) {
    super(`invalid integer: ${reason}`);
    this.name = "InvalidIntegerError";
  }
}

// Exactly base-10 digits, no sign, no leading zero (except the literal "0").
const CANONICAL_INT = /^(0|[1-9][0-9]*)$/;

/**
 * Parse an untrusted JSON value into a canonical non-negative integer.
 *
 * Accepts a JS number only when it is already a non-negative safe integer, or a
 * string that is the exact canonical decimal representation of one. Everything
 * else throws. This deliberately rejects `" 8443"`, `"+8443"`, `"08443"`,
 * `"8443\n"`, `8443.0` serialized oddly, `1e4`, `"０"` (fullwidth), etc.
 */
export function parseCanonicalUint(value: unknown): number {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new InvalidIntegerError("number is not an integer");
    if (value < 0) throw new InvalidIntegerError("number is negative");
    if (!Number.isSafeInteger(value)) throw new InvalidIntegerError("number exceeds safe integer range");
    return value;
  }
  if (typeof value !== "string") {
    throw new InvalidIntegerError(`expected number or string, got ${typeof value}`);
  }
  if (!CANONICAL_INT.test(value)) {
    throw new InvalidIntegerError("string is not a canonical base-10 integer");
  }
  // CANONICAL_INT already forbids leading zeros and non-ASCII digits; a value
  // that long would also overflow, so guard the numeric range explicitly.
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidIntegerError("value exceeds safe integer range");
  return parsed;
}

/**
 * Parse an untrusted value as a TCP port number in [1, 65535].
 * Used for every port the broker will hand to the CLI.
 */
export function parsePort(value: unknown): number {
  const n = parseCanonicalUint(value);
  if (n < 1 || n > 65_535) throw new InvalidIntegerError(`port ${n} out of range 1-65535`);
  return n;
}
