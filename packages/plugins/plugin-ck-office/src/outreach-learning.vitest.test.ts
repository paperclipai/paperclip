import { describe, expect, it } from "vitest";
import {
  rejectionFeedbackLesson,
  shouldLearnSentOutreachEdit,
} from "./outreach-learning.js";

describe("outreach learning", () => {
  it("turns a human Hold reason into a transferable style lesson", () => {
    expect(rejectionFeedbackLesson("\"Ich wende mich heute an Sie\" does not sound like me"))
      .toContain("underlying preference");
  });

  it("does not learn the system-generated outbox cancellation reason", () => {
    expect(rejectionFeedbackLesson("Cancelled in Outreach outbox; no email was sent.")).toBeNull();
  });

  it("never learns test-locked or test-wording edits as seller voice", () => {
    expect(shouldLearnSentOutreachEdit({
      edited: true,
      testLock: true,
      subject: "Real subject",
      body: "Real body",
    })).toBe(false);
    expect(shouldLearnSentOutreachEdit({
      edited: true,
      testLock: false,
      subject: "Kurzer Test",
      body: "Bitte ignorieren.",
    })).toBe(false);
  });

  it("learns a real human edit after a live non-test send", () => {
    expect(shouldLearnSentOutreachEdit({
      edited: true,
      testLock: false,
      subject: "Degustation",
      body: "Sehr geehrte Damen und Herren",
    })).toBe(true);
  });
});
