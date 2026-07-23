import { describe, expect, it } from "vitest";
import { quoteMentionsMeetingDate, validateMeetingWrite } from "./meeting-write-guard.js";

describe("validateMeetingWrite", () => {
  it("rejects placeholder and diagnostic calendar writes", () => {
    expect(validateMeetingWrite({
      name: "placeholder-check",
      accountId: "6a3b61ff4dd515b2f",
      evidenceEmailId: "6a5ba33f97c36ba8c",
      confirmationQuote: "Der 28. August passt uns gut.",
    })).toMatchObject({ ok: false });
  });

  it("requires a linked account and communication evidence", () => {
    expect(validateMeetingWrite({ name: "Tres Hermanos Vorstellung" })).toMatchObject({ ok: false });
    expect(validateMeetingWrite({
      name: "Tres Hermanos Vorstellung",
      accountId: "6a3b61ff4dd515b2f",
    })).toMatchObject({ ok: false });
  });

  it("allows an evidence-backed venue meeting", () => {
    expect(validateMeetingWrite({
      name: "Tres Hermanos Vorstellung — Bürgenstock Resort",
      accountId: "6a3b61ff4dd515b2f",
      evidenceEmailId: "6a5ba33f97c36ba8c",
      confirmationQuote: "Der 28. August passt uns gut.",
    })).toEqual({ ok: true });
  });

  it("recognizes the confirmed date in German, English, French, or numeric form", () => {
    expect(quoteMentionsMeetingDate("Der 28. August passt uns gut.", "2026-08-28 18:00")).toBe(true);
    expect(quoteMentionsMeetingDate("Friday, August 28 works for us.", "2026-08-28 18:00")).toBe(true);
    expect(quoteMentionsMeetingDate("Le 28 août nous convient.", "2026-08-28 18:00")).toBe(true);
    expect(quoteMentionsMeetingDate("28.08.2026 ist bestätigt.", "2026-08-28 18:00")).toBe(true);
    expect(quoteMentionsMeetingDate("Please propose one or more dates.", "2026-08-28 18:00")).toBe(false);
  });
});
