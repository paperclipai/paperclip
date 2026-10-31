import type { PluginContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_DOCUMENT_KEY, DEFAULT_SCAN_LIMIT, MAX_SCAN_LIMIT } from "./constants.js";
import { dokumanMetnindenJsonAyikla, parseSosyalMedyaVerisi } from "./parse-durum.js";
import type { PanelConfig, SosyalMedyaSnapshot } from "./types.js";

/** Eklenti ayarlarını güvenli değerlere göre çözümle (eksik/hatalı değerlere tolerans göster). */
export async function panelAyariniCoz(ctx: PluginContext, companyId?: string): Promise<PanelConfig> {
  let ham: Record<string, unknown> = {};
  try {
    const okunan = (await ctx.config.get(companyId)) as unknown;
    if (typeof okunan === "object" && okunan !== null) ham = okunan as Record<string, unknown>;
  } catch {
    ham = {};
  }

  const issueId = typeof ham.issueId === "string" && ham.issueId.trim() ? ham.issueId.trim() : null;
  const documentKey =
    typeof ham.documentKey === "string" && ham.documentKey.trim() ? ham.documentKey.trim() : DEFAULT_DOCUMENT_KEY;

  let scanLimit = DEFAULT_SCAN_LIMIT;
  const hamScanLimit = ham.scanLimit;
  if (typeof hamScanLimit === "number" && Number.isInteger(hamScanLimit)) {
    scanLimit = Math.min(Math.max(hamScanLimit, 1), MAX_SCAN_LIMIT);
  } else if (typeof hamScanLimit === "string" && /^\d+$/.test(hamScanLimit.trim())) {
    scanLimit = Math.min(Math.max(Number.parseInt(hamScanLimit, 10), 1), MAX_SCAN_LIMIT);
  }

  return { issueId, documentKey, scanLimit };
}

/** companyId boş gelirse görünür ilk şirketi döndür. */
export async function sirketiCoz(ctx: PluginContext, companyId?: string): Promise<string | null> {
  if (typeof companyId === "string" && companyId.trim()) return companyId.trim();
  const sirketler = await ctx.companies.list({ limit: 1, offset: 0 });
  return sirketler[0]?.id ?? null;
}

/**
 * Durum dokümanını çöz ve panel için snapshot üret.
 * Ayarlarda issueId varsa yalnızca o issue'nun dokümanına bakar; yoksa en
 * güncel scanLimit issue'nun dokümanlarında documentKey anahtarını arar.
 */
export async function durumSnapshotGetir(ctx: PluginContext, companyId?: string): Promise<SosyalMedyaSnapshot> {
  const sirketId = await sirketiCoz(ctx, companyId);
  if (!sirketId) {
    return { status: "no-company", source: null, scannedIssueCount: 0 };
  }
  const ayar = await panelAyariniCoz(ctx, sirketId);
  return await snapshotUret(ctx, sirketId, ayar);
}

async function snapshotUret(ctx: PluginContext, companyId: string, ayar: PanelConfig): Promise<SosyalMedyaSnapshot> {
  const adaylar: Array<{ issueId: string; issueTitle: string | null }> = [];

  if (ayar.issueId) {
    const issue = await ctx.issues.get(ayar.issueId, companyId);
    if (!issue) {
      return {
        status: "not-found",
        source: { issueId: ayar.issueId, issueTitle: null, documentKey: ayar.documentKey },
        scannedIssueCount: 1,
        reason: `Ayarlanan issue bulunamadı: ${ayar.issueId}`,
      };
    }
    adaylar.push({ issueId: issue.id, issueTitle: issue.title });
  } else {
    const issues = await ctx.issues.list({ companyId, limit: ayar.scanLimit, offset: 0 });
    for (const issue of issues) {
      adaylar.push({ issueId: issue.id, issueTitle: issue.title });
    }
  }

  for (const aday of adaylar) {
    const ozetler = await ctx.issues.documents.list(aday.issueId, companyId);
    if (!ozetler.some((ozet) => ozet.key === ayar.documentKey)) continue;

    const dokuman = await ctx.issues.documents.get(aday.issueId, ayar.documentKey, companyId);
    if (!dokuman || typeof dokuman.body !== "string") continue;

    const kaynak = { issueId: aday.issueId, issueTitle: aday.issueTitle, documentKey: ayar.documentKey };
    const json = dokumanMetnindenJsonAyikla(dokuman.body);
    if (!json.ok) {
      return { status: "invalid", source: kaynak, scannedIssueCount: adaylar.length, reason: json.hata };
    }

    const sonuc = parseSosyalMedyaVerisi(json.value);
    if (!sonuc.ok) {
      return { status: "invalid", source: kaynak, scannedIssueCount: adaylar.length, reason: sonuc.hata };
    }
    if (sonuc.veri.accounts.length === 0 && !sonuc.veri.updatedAt) {
      return { status: "empty", source: kaynak, scannedIssueCount: adaylar.length };
    }
    return {
      status: "ok",
      data: sonuc.veri,
      uyarilar: sonuc.uyarilar,
      source: kaynak,
      scannedIssueCount: adaylar.length,
    };
  }

  return {
    status: "not-found",
    source: { issueId: ayar.issueId, issueTitle: null, documentKey: ayar.documentKey },
    scannedIssueCount: adaylar.length,
    reason: ayar.issueId
      ? `Ayarlanan issue'da ${ayar.documentKey} dokümanı yok.`
      : `Son ${adaylar.length} issue'da ${ayar.documentKey} dokümanı bulunamadı.`,
  };
}
