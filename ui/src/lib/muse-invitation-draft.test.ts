// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { readMuseInvitationDraft, saveMuseInvitationDraft } from "./muse-invitation-draft";

afterEach(() => localStorage.clear());
it("retains only name and role in the exact company and operator scope", () => {
  const draft = { name: "Maia", role: "researcher" as const, ticket: "secret-not-to-save", setupInstruction: "private setup" };
  saveMuseInvitationDraft("company-a", "operator-a", draft);
  expect(readMuseInvitationDraft("company-a", "operator-a")).toEqual({ name: "Maia", role: "researcher" });
  expect(readMuseInvitationDraft("company-b", "operator-a").name).toBe("");
  expect(readMuseInvitationDraft("company-a", "operator-b").name).toBe("");
  expect(readMuseInvitationDraft("company-a", null).name).toBe("");
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("secret-not-to-save");
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("setupInstruction");
});
it("rejects a corrupt role and does not share a signed-out draft", () => {
  saveMuseInvitationDraft("company", null, { name: "Anonymous", role: "general" });
  expect(localStorage.length).toBe(0);
  localStorage.setItem("paperclip.muse-invitation.company.operator", JSON.stringify({ name: "Maia", role: "invented" }));
  expect(readMuseInvitationDraft("company", "operator")).toEqual({ name: "", role: "general" });
});
