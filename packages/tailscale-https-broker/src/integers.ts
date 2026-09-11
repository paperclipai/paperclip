/**
 * Canonical integer parsing for the broker. Commands and Serve mutations are
 * generated only from integers that pass these checks, never from raw strings,
 * URLs, or unvalidated JSON (PAP-17050 verdict requirement #4).
 */

/** Ports are constrained to the valid TCP range. */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/**
 * Assert a JSON-decoded value is a canonical, safe, in-range port number.
 * Rejects non-numbers, non-integers, NaN/Infinity, negatives, and out-of-range
 * values. Returns the number so call sites read as validated.
 */
export function assertCanonicalPort(value: unknown): number {
  if (typeof value !== "number") {
    throw new Error("port must be a JSON number");
  }
  if (!Number.isInteger(value)) {
    throw new Error("port must be an integer");
  }
  if (value < MIN_PORT || value > MAX_PORT) {
    throw new Error(`port out of range [${MIN_PORT}, ${MAX_PORT}]`);
  }
  return value;
}

/**
 * Parse an integer from an untrusted STRING with strict canonical rules.
 * Rejects: empty, whitespace, signs, leading zeros (non-canonical), decimals,
 * exponents, thousands separators, Unicode digits, and anything that does not
 * round-trip exactly back to its canonical decimal form. Used at any boundary
 * where a numeric value could arrive as text.
 */
export function parseCanonicalIntegerString(raw: unknown): number {
  if (typeof raw !== "string") {
    throw new Error("expected a string integer");
  }
  // Only ASCII digits, at least one, no sign, no whitespace. `^[0-9]+$` with a
  // JS regex still matches only ASCII 0-9 (it does not match Unicode digits
  // unless the `u` + property-escape form is used), which is what we want.
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error("integer contains non-canonical characters");
  }
  // Reject non-canonical leading zeros ("007", "00").
  if (raw.length > 1 && raw[0] === "0") {
    throw new Error("integer has non-canonical leading zero");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("integer overflow / not a safe integer");
  }
  // Round-trip guard against any residual ambiguity.
  if (String(parsed) !== raw) {
    throw new Error("integer did not round-trip canonically");
  }
  return parsed;
}
