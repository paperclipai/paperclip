/** Monetary storage uses nanodollars: 10^7 units per cent, 10^9 per USD.
 * Numbers are accepted only at compatibility boundaries. All arithmetic uses
 * integers; decimal inputs are rounded once, half away from zero. */
export const MONEY_SCALE = 10_000_000n;
export const MAX_MONEY_UNITS = 10n ** 24n - 1n;
export type MoneyInput = string | number;

function decimalUnits(value: MoneyInput, places: number): bigint {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Money must be finite");
  if (typeof value === "number" && Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new Error("Use a decimal string for large monetary values");
  const text = String(value);
  if (text.length > 160) throw new Error("Money exceeds supported precision");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) throw new Error("Invalid decimal money amount");
  const exponent = Number(match[4] ?? 0);
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) throw new Error("Money exponent is out of range");
  const digits = BigInt(match[2] + (match[3] ?? ""));
  const shift = places + exponent - (match[3]?.length ?? 0);
  const divisor = shift < 0 ? 10n ** BigInt(-shift) : 1n;
  const magnitude = shift >= 0 ? digits * 10n ** BigInt(shift) : (digits + divisor / 2n) / divisor;
  if (magnitude > MAX_MONEY_UNITS) throw new Error("Money exceeds numeric(24,7) storage");
  return match[1] === "-" ? -magnitude : magnitude;
}

export function centsToUnits(value: MoneyInput): bigint { return decimalUnits(value, 7); }
export function usdToUnits(value: MoneyInput): bigint { return decimalUnits(value, 9); }
export function unitsToCents(value: bigint): string {
  if (value > MAX_MONEY_UNITS || value < -MAX_MONEY_UNITS) throw new Error("Money exceeds numeric(24,7) storage");
  const magnitude = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${magnitude / MONEY_SCALE}.${String(magnitude % MONEY_SCALE).padStart(7, "0")}`;
}
export function normalizeCents(value: MoneyInput): string { return unitsToCents(centsToUnits(value)); }
export function usdToCents(value: MoneyInput): string { return unitsToCents(usdToUnits(value)); }
/** Exact editable USD value; unlike display formatting, this never rounds cents. */
export function centsToUsd(value: MoneyInput): string {
  const units = centsToUnits(value);
  const magnitude = units < 0n ? -units : units;
  return `${units < 0n ? "-" : ""}${magnitude / 1_000_000_000n}.${String(magnitude % 1_000_000_000n).padStart(9, "0")}`;
}
/** Approximate legacy/UI value. Never use this conversion for a money decision. */
export function centsToNumber(value: MoneyInput): number { return Number(normalizeCents(value)); }
export function addCents(...values: MoneyInput[]): string { return unitsToCents(values.reduce((sum, value) => sum + centsToUnits(value), 0n)); }
export function subtractCents(a: MoneyInput, b: MoneyInput): string { return unitsToCents(centsToUnits(a) - centsToUnits(b)); }
export function compareCents(a: MoneyInput, b: MoneyInput): number {
  const left = centsToUnits(a), right = centsToUnits(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function formatUsdExact(cents: MoneyInput): string {
  const units = centsToUnits(cents);
  const magnitude = units < 0n ? -units : units;
  const rounded = (magnitude + MONEY_SCALE / 2n) / MONEY_SCALE;
  return `${units < 0n ? "-" : ""}$${rounded / 100n}.${String(rounded % 100n).padStart(2, "0")}`;
}
