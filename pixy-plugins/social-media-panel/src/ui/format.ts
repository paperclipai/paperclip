const TAM_SAYI = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

/** Takipçi/adet değerini kısa biçimde göster; veri yoksa "—". */
export function formatSayi(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return TAM_SAYI.format(value);
}

/** 30 günlük değişimi işaretli göster; veri yoksa boş metin. */
export function formatDegisim(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const isaret = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${isaret}${TAM_SAYI.format(Math.abs(value))}`;
}

/** 30 günlük değişimin tonu: pozitif/negatif/nötr. */
export function degisimTonu(value: number | null | undefined): "positive" | "negative" | "neutral" | "none" {
  if (value === null || value === undefined || !Number.isFinite(value)) return "none";
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "neutral";
}

const YUZDE = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/**
 * Etkileşim oranını yüzde metni olarak göster.
 * Oran 0-1 aralığındaysa yüzdeye çevirilir (0.05 → "%5");
 * 1'den büyük değerler zaten yüzde kabul edilir.
 */
export function formatEtkilesimOrani(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const yuzde = value > 0 && value <= 1 ? value * 100 : value;
  return `%${YUZDE.format(yuzde)}`;
}

/** ISO tarih/belirsiz dizeyi okunur Türkçe metne çevir; dönüştürülemiyorsa ham değer. */
export function formatTarih(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return "—";
  const tarih = new Date(value);
  if (Number.isNaN(tarih.getTime())) return value;
  return tarih.toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" });
}
