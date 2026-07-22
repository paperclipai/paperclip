import { describe, expect, it } from "vitest";
import { validateMeetingWrite } from "./meeting-write-guard.js";

describe("validateMeetingWrite", () => {
  it("rejects placeholder and diagnostic calendar writes", () => {
    expect(validateMeetingWrite({
      name: "placeholder-check",
      accountId: "6a3b61ff4dd515b2f",
      evidenceEmailId: "6a5ba33f97c36ba8c",
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
    })).toEqual({ ok: true });
  });
});
