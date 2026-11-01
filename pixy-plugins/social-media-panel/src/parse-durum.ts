/**
 * Sosyal Medya durumu veri sözleşmesi (tek dosya).
 * Şema: {updatedAt, accounts:[{platform, handle, url, followers, followersDelta30d, engagementRate, recentPosts, recommendations}]}
 */

export interface SonGonderi {
  title: string | null;
  url: string | null;
  publishedAt: string | null;
}

export interface SosyalMedyaHesap {
  platform: string;
  handle: string | null;
  url: string | null;
  followers: number | null;
  followersDelta30d: number | null;
  engagementRate: number | null;
  recentPosts: SonGonderi[];
  recommendations: string[];
}

export interface SosyalMedyaVeri {
  updatedAt: string | null;
  accounts: SosyalMedyaHesap[];
}

export type ParseSonuc =
  | { ok: true; veri: SosyalMedyaVeri; uyarilar: string[] }
  | { ok: false; hata: string };

/** Marka markdown/JSON gövdesinden ilk ayrıştırılabilir JSON değerini çıkar. */
export function dokumanMetnindenJsonAyikla(text: string): { ok: true; value: unknown } | { ok: false; hata: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, hata: "Doküman gövdesi boş." };

  const direkt = gunlukJsonDene(trimmed);
  if (direkt.ok) return direkt;

  const kodBlogu = ilkKodBlogu(trimmed);
  if (kodBlogu) {
    const blogIci = gunlukJsonDene(kodBlogu);
    if (blogIci.ok) return blogIci;
  }

  return { ok: false, hata: "Doküman gövdesinde ayrıştırılabilir JSON bulunamadı." };
}

function ilkKodBlogu(text: string): string | null {
  const desen = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let eslesme: RegExpExecArray | null;
  while ((eslesme = desen.exec(text)) !== null) {
    if (eslesme[1].trim()) return eslesme[1];
  }
  return null;
}

function gunlukJsonDene(text: string): { ok: true; value: unknown } | { ok: false; hata: string } {
  try {
    const value = JSON.parse(text) as unknown;
    return { ok: true, value };
  } catch {
    return { ok: false, hata: "JSON.parse başarısız." };
  }
}

/** Belgeden ayrıştırılmış JSON değerini şema sözleşmesine göre normalleştirir. */
export function parseSosyalMedyaVerisi(raw: unknown): ParseSonuc {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, hata: "Köki JSON bir obje olmalı (updatedAt + accounts)." };
  }
  const kok = raw as Record<string, unknown>;
  const uyarilar: string[] = [];

  let updatedAt: string | null = null;
  if (typeof kok.updatedAt === "string" && kok.updatedAt.trim()) {
    updatedAt = kok.updatedAt.trim();
  } else if (kok.updatedAt !== undefined && kok.updatedAt !== null) {
    uyarilar.push("updatedAt beklenen biçimde değil; yok sayıldı.");
  }

  const hesaplar: SosyalMedyaHesap[] = [];
  let hesapAdaylari: unknown[] | null = null;
  if (Array.isArray(kok.accounts)) hesapAdaylari = kok.accounts;
  else uyarilar.push("accounts dizisi yok; hesap listesi boş kabul edildi.");

  if (hesapAdaylari) {
    hesapAdaylari.forEach((aday, index) => {
      const son: { hesap: SosyalMedyaHesap | null; uyarilar: string[] } = hesabiNormalleştir(aday, `accounts[${index}]`);
      for (const u of son.uyarilar) uyarilar.push(u);
      if (son.hesap) hesaplar.push(son.hesap);
    });
  }

  return { ok: true, veri: { updatedAt, accounts: hesaplar }, uyarilar };
}

function hesabiNormalleştir(
  aday: unknown,
  konum: string,
): { hesap: SosyalMedyaHesap | null; uyarilar: string[] } {
  const uyarilar: string[] = [];
  if (typeof aday !== "object" || aday === null) {
    uyarilar.push(`${konum}: hesap girişi bir obje değil, atlandı.`);
    return { hesap: null, uyarilar };
  }
  const kaynak = aday as Record<string, unknown>;

  const platform = typeof kaynak.platform === "string" && kaynak.platform.trim() ? kaynak.platform.trim() : null;
  if (!platform) uyarilar.push(`${konum}.platform: dize bekleniyordu, boş bırakıldı.`);

  const handle = opsiyonelDize(kaynak.handle, `${konum}.handle`, uyarilar);
  const url = opsiyonelDize(kaynak.url, `${konum}.url`, uyarilar);
  const followers = opsiyonelSayi(kaynak.followers, `${konum}.followers`, uyarilar);
  const followersDelta30d = opsiyonelSayi(kaynak.followersDelta30d, `${konum}.followersDelta30d`, uyarilar);
  const engagementRate = opsiyonelSayi(kaynak.engagementRate, `${konum}.engagementRate`, uyarilar);

  const recentPosts: SonGonderi[] = [];
  if (Array.isArray(kaynak.recentPosts)) {
    kaynak.recentPosts.forEach((gonderiAdayi, index) => {
      const son = gonderiyiNormalleştir(gonderiAdayi, `${konum}.recentPosts[${index}]`, uyarilar);
      if (son) recentPosts.push(son);
    });
  } else if (kaynak.recentPosts !== undefined && kaynak.recentPosts !== null) {
    uyarilar.push(`${konum}.recentPosts: dizi bekleniyordu, yok sayıldı.`);
  }

  const recommendations: string[] = [];
  if (Array.isArray(kaynak.recommendations)) {
    kaynak.recommendations.forEach((madde, index) => {
      if (typeof madde === "string" && madde.trim()) recommendations.push(madde);
      else uyarilar.push(`${konum}.recommendations[${index}]: dize bekleniyordu, atlendi.`);
    });
  } else if (kaynak.recommendations !== undefined && kaynak.recommendations !== null) {
    uyarilar.push(`${konum}.recommendations: dizi bekleniyordu, yok sayıldı.`);
  }

  return {
    hesap: {
      platform: platform ?? "(bilinmeyen platform)",
      handle,
      url,
      followers,
      followersDelta30d,
      engagementRate,
      recentPosts,
      recommendations,
    },
    uyarilar,
  };
}

function gonderiyiNormalleştir(aday: unknown, konum: string, genelUyarilar: string[]): SonGonderi | null {
  if (typeof aday !== "object" || aday === null) {
    genelUyarilar.push(`${konum}: gönderi girişi bir obje değil, atlandı.`);
    return null;
  }
  const kaynak = aday as Record<string, unknown>;
  return {
    title: opsiyonelDize(kaynak.title, `${konum}.title`, genelUyarilar),
    url: opsiyonelDize(kaynak.url, `${konum}.url`, genelUyarilar),
    publishedAt: opsiyonelDize(kaynak.publishedAt, `${konum}.publishedAt`, genelUyarilar),
  };
}

function opsiyonelDize(deger: unknown, konum: string, uyarilar: string[]): string | null {
  if (deger === undefined || deger === null) return null;
  if (typeof deger === "string" && deger.trim()) return deger.trim();
  uyarilar.push(`${konum}: dize bekleniyordu, yok sayıldı.`);
  return null;
}

function opsiyonelSayi(deger: unknown, konum: string, uyarilar: string[]): number | null {
  if (deger === undefined || deger === null) return null;
  if (typeof deger === "number" && Number.isFinite(deger)) return deger;
  uyarilar.push(`${konum}: sayı bekleniyordu, yok sayıldı.`);
  return null;
}

/** Veri yoksa UI'ın boş duruma geçmesi için referans değer. */
export function bosVeri(): SosyalMedyaVeri {
  return { updatedAt: null, accounts: [] };
}
