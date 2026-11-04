import { expect, it } from "vitest";
import { solicitsChatCredential } from "./external-credential-language.js";

it("accepts secure-form entry that explicitly excludes chat", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat.")).toBe(false);
  expect(solicitsChatCredential("Enter your credential in the secure form.")).toBe(false);
});

it("retains positive and mixed chat destinations around a secure-form instruction", () => {
  for (const text of [
    "Enter your credential here in chat.",
    "Enter your credential in chat and in the secure form, not in messages.",
    "Enter your credential in the secure form, not in chat, or share it here.",
    "Enter your credential in the secure form, not in chat. Then send it here.",
    "Send your credential here. Enter your credential in the secure form, not in chat.",
    "Never share your credential. Then send it here in chat.",
  ]) expect(solicitsChatCredential(text), text).toBe(true);
});

it("keeps a later chat destination attached to the secure-entry imperative", () => {
  for (const conjunction of ["but", "then", "however"]) {
    expect(solicitsChatCredential(`Enter your personal publishing credential in the secure form, not in chat ${conjunction} here.`)).toBe(true);
  }
});
it("accepts the reported explicit chat exclusions and secure-target articles", () => {
  for (const text of [
    "Enter your personal publishing credential in the secure form, not in the chat.",
    "Enter your personal publishing credential in the secure form, and not in chat.",
    "Enter your personal publishing credential in the secure form, never in chat.",
    "Enter your personal publishing credential in the secure form, rather than in chat.",
    "Enter your personal publishing credential in your secure form, not in chat.",
  ]) expect(solicitsChatCredential(text), text).toBe(false);
});
it("does not let a warning negate a later positive imperative", () => {
  expect(solicitsChatCredential("Never share your credential but send the key here in chat.")).toBe(true);
});
it("keeps a safe chat exclusion when the follow-on clause is a settings instruction", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat but you can review it in settings.")).toBe(false);
});
it("does not carry a destination across a sentence or a negative prohibition", () => {
  expect(solicitsChatCredential("Enter your credential in the secure form, not in chat. Here.")).toBe(false);
  expect(solicitsChatCredential("Never enter your credential in the secure form, not in chat but here.")).toBe(false);
});
