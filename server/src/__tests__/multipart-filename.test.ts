import { describe, expect, it } from "vitest";
import { decodeMultipartFilename } from "../lib/multipart-filename.js";

// Simulate what multer/busboy does to a UTF-8 filename: take the raw UTF-8
// bytes from the Content-Disposition header and decode them as latin1.
function asMulterOriginalname(utf8Name: string): string {
  return Buffer.from(utf8Name, "utf8").toString("latin1");
}

describe("decodeMultipartFilename", () => {
  it("recovers latin1-mojibaked Korean filenames", () => {
    const name = "사업자등록증_2024년_홍길동상사.xlsx";
    expect(decodeMultipartFilename(asMulterOriginalname(name))).toBe(name);
  });

  it("recovers real-world PLA-80 examples", () => {
    for (const name of [
      "2. 제안요청서 및 과업지시서.pdf",
      "3. 프로그램 계획(안).pdf",
      "제13회_21세기인문가치포럼_제안서_목차.xlsx",
    ]) {
      expect(decodeMultipartFilename(asMulterOriginalname(name))).toBe(name);
    }
  });

  it("leaves ASCII filenames untouched", () => {
    expect(decodeMultipartFilename("quarterly-report.pdf")).toBe("quarterly-report.pdf");
  });

  it("leaves already-correct UTF-8 filenames untouched", () => {
    expect(decodeMultipartFilename("제안서.pdf")).toBe("제안서.pdf");
    expect(decodeMultipartFilename("提案書.pdf")).toBe("提案書.pdf");
  });

  it("leaves Latin-1 accented filenames untouched", () => {
    // A lone high byte (é=0xE9, ï=0xEF, ñ=0xF1, ü=0xFC) is not a valid UTF-8
    // start byte for the following ASCII, so the latin1->utf8 reinterpretation
    // yields a replacement char and the round-trip guard returns the input as-is.
    for (const name of ["résumé.pdf", "naïve Bericht.docx", "mañana.txt", "Müller.csv"]) {
      expect(decodeMultipartFilename(name)).toBe(name);
    }
  });

  it("is idempotent (double application is a no-op)", () => {
    const once = decodeMultipartFilename(asMulterOriginalname("계획안.docx"));
    expect(once).toBe("계획안.docx");
    expect(decodeMultipartFilename(once)).toBe(once);
  });

  it("passes through null, undefined, and empty values", () => {
    expect(decodeMultipartFilename(null)).toBeNull();
    expect(decodeMultipartFilename(undefined)).toBeUndefined();
    expect(decodeMultipartFilename("")).toBe("");
  });
});
