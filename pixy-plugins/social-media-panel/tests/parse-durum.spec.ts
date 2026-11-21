import { describe, expect, it } from "vitest";
import { bosVeri, dokumanMetnindenJsonAyikla, parseSosyalMedyaVerisi } from "../src/parse-durum.js";

describe("dokumanMetnindenJsonAyikla", () => {
  it("duz JSON gövdesini ayrıştırır", () => {
    const sonuc = dokumanMetnindenJsonAyikla('{"updatedAt":null,"accounts":[]}');
    expect(sonuc.ok).toBe(true);
  });

  it("markdown içindeki json kod bloğunu ayrıştırır", () => {
    const sonuc = dokumanMetnindenJsonAyikla("# Status\n\n```json\n{\"updatedAt\":\"2026-10-30T10:00:00Z\",\"accounts\":[]}\n```\n");
    expect(sonuc.ok).toBe(true);
  });

  it("json olmayan gövdede hata döndürür", () => {
    const sonuc = dokumanMetnindenJsonAyikla("bu bir fikir listesi *\n- madde 1\n");
    expect(sonuc.ok).toBe(false);
    expect(sonuc.ok === false && sonuc.hata.length > 0).toBe(true);
  });

  it("bos gövdede hata döndürür", () => {
    const sonuc = dokumanMetnindenJsonAyikla("   ");
    expect(sonuc.ok).toBe(false);
  });
});

describe("parseSosyalMedyaVerisi", () => {
  it("tam şemayı olduğu gibi okur", () => {
    const sonuc = parseSosyalMedyaVerisi({
      updatedAt: "2026-10-30T10:00:00Z",
      accounts: [
        {
          platform: "instagram",
          handle: "@pixydigital",
          url: "https://instagram.com/pixydigital",
          followers: 1234,
          followersDelta30d: 23,
          engagementRate: 0.05,
          recentPosts: [{ title: "Gönderi A", url: "https://instagram.com/p/1", publishedAt: "2026-10-20" }],
          recommendations: ["Haftada üç gönderi"],
        },
      ],
    });
    expect(sonuc.ok).toBe(true);
    if (!sonuc.ok) return;
    expect(sonuc.veri.updatedAt).toBe("2026-10-30T10:00:00Z");
    expect(sonuc.veri.accounts).toHaveLength(1);
    expect(sonuc.veri.accounts[0].platform).toBe("instagram");
    expect(sonuc.veri.accounts[0].followers).toBe(1234);
    expect(sonuc.veri.accounts[0].recentPosts[0].title).toBe("Gönderi A");
    expect(sonuc.veri.accounts[0].recommendations).toEqual(["Haftada üç gönderi"]);
    expect(sonuc.uyarilar).toHaveLength(0);
  });

  it("kök obje olmadığında hata döndürür", () => {
    expect(parseSosyalMedyaVerisi([1, 2]).ok).toBe(false);
    expect(parseSosyalMedyaVerisi("metin").ok).toBe(false);
    expect(parseSosyalMedyaVerisi(null).ok).toBe(false);
  });

  it("eksik alanları toleranslı okur ve uyarı üretir", () => {
    const sonuc = parseSosyalMedyaVerisi({
      accounts: [{ platform: "  x ", followers: "yüz" }],
    });
    expect(sonuc.ok).toBe(true);
    if (!sonuc.ok) return;
    expect(sonuc.veri.updatedAt).toBeNull();
    expect(sonuc.veri.accounts[0].platform).toBe("x");
    expect(sonuc.veri.accounts[0].followers).toBeNull();
    expect(sonuc.uyarilar.length).toBeGreaterThan(0);
  });

  it("listenin dışındaki girişleri atlar", () => {
    const sonuc = parseSosyalMedyaVerisi({
      accounts: ["olmali-degil", null, { platform: "linkedin" }],
    });
    expect(sonuc.ok).toBe(true);
    if (!sonuc.ok) return;
    expect(sonuc.veri.accounts).toHaveLength(1);
    expect(sonuc.veri.accounts[0].platform).toBe("linkedin");
  });

  it("hesapsız veri için ok döndürür (UI boş duruma düşer)", () => {
    const sonuc = parseSosyalMedyaVerisi({ updatedAt: "2026-10-30", accounts: [] });
    expect(sonuc.ok).toBe(true);
    if (!sonuc.ok) return;
    expect(sonuc.veri.accounts).toHaveLength(0);
  });

  it("bosVeri hesapsız ve tarihsiz referans döndürür", () => {
    const veri = bosVeri();
    expect(veri).toEqual({ updatedAt: null, accounts: [] });
  });
});
