export function isKoreanLocale(locale: string | null | undefined) {
  const normalized = locale?.toLowerCase();
  return normalized === "ko" || normalized?.startsWith("ko-") === true;
}
