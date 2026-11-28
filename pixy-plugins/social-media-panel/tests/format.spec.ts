import { describe, expect, it } from "vitest";
import { degisimTonu, formatDegisim, formatEtkilesimOrani, formatSayi, formatTarih } from "../src/ui/format.js";

describe("formatSayi", () => {
  it("sayıyı binlik ayraçla gösterir", () => {
    expect(formatSayi(1234)).toBe("1.234");
  });

  it("eksik değer için tire gösterir", () => {
    expect(formatSayi(null)).toBe("—");
    expect(formatSayi(undefined)).toBe("—");
    expect(formatSayi(Number.NaN)).toBe("—");
  });
});

describe("formatDegisim", () => {
  it("artışa işaret ekler", () => {
    expect(formatDegisim(526)).toBe("+526");
  });

  it("düşüşü eksiyle gösterir", () => {
    expect(formatDegisim(-42)).toBe("−42");
  });

  it("sıfırı nötr gösterir", () => {
    expect(formatDegisim(0)).toBe("0");
  });

  it("eksik değer boş döndürür", () => {
    expect(formatDegisim(null)).toBe("");
  });
});

describe("degisimTonu", () => {
  it("pozitif/negatif/nötr/none döndürür", () => {
    expect(degisimTonu(3)).toBe("positive");
    expect(degisimTonu(-3)).toBe("negative");
    expect(degisimTonu(0)).toBe("neutral");
    expect(degisimTonu(null)).toBe("none");
  });
});

describe("formatEtkilesimOrani", () => {
  it("0-1 aralığını yüzdeye çevirir", () => {
    expect(formatEtkilesimOrani(0.052)).toBe("%5,2");
    expect(formatEtkilesimOrani(0.05)).toBe("%5");
  });

  it("zaten yüzde olan değeri olduğu gibi gösterir", () => {
    expect(formatEtkilesimOrani(7.5)).toBe("%7,5");
  });

  it("eksik değer için tire gösterir", () => {
    expect(formatEtkilesimOrani(null)).toBe("—");
  });
});

describe("formatTarih", () => {
  it("ISO tarihi okunur metne çevirir", () => {
    const sonuc = formatTarih("2026-10-30T09:00:00Z");
    expect(sonuc).toContain("2026");
  });

  it("dönüştürülemeyen değeri ham gösterir", () => {
    expect(formatTarih("yarın")).toBe("yarın");
  });

  it("eksik değer için tire gösterir", () => {
    expect(formatTarih(null)).toBe("—");
  });
});
