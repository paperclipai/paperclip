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
