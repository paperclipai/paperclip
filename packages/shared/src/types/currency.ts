export type CurrencyCode = "USD" | "EUR" | "UYU" | "ARS";

export const SUPPORTED_CURRENCIES: CurrencyCode[] = ["USD", "EUR", "UYU", "ARS"];

export const DEFAULT_CURRENCY: CurrencyCode = "USD";

export const CURRENCY_SYMBOLS: Record<CurrencyCode, string> = {
  USD: "$",
  EUR: "€",
  UYU: "$",
  ARS: "$",
};

export const CURRENCY_NAMES: Record<CurrencyCode, string> = {
  USD: "Dólar estadounidense",
  EUR: "Euro",
  UYU: "Peso uruguayo",
  ARS: "Peso argentino",
};

export function isValidCurrency(code: string): code is CurrencyCode {
  return SUPPORTED_CURRENCIES.includes(code as CurrencyCode);
}

export function getCurrencySymbol(code: CurrencyCode): string {
  return CURRENCY_SYMBOLS[code] ?? "$";
}

export function getCurrencyName(code: CurrencyCode): string {
  return CURRENCY_NAMES[code] ?? code;
}