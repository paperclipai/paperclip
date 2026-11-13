// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { consumeSkillSourceReturn, rememberSkillSourceReturn, skillSourceReturnPath } from "./skill-source-connect-return";

afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); });

it("retains a company-scoped, one-time return through an OAuth reload", () => {
  const sourceId = "94df7764-6811-43e4-ac85-a6d6b636d73d";
  rememberSkillSourceReturn("company-a", sourceId);
  expect(skillSourceReturnPath("company-b")).toBeNull();
  expect(consumeSkillSourceReturn("company-a")).toBe(`/skills/sources/${sourceId}`);
  expect(skillSourceReturnPath("company-a")).toBeNull();
});

it("expires abandoned setup and rejects arbitrary redirect destinations", () => {
  vi.useFakeTimers();
  rememberSkillSourceReturn("company-a", "new");
  vi.advanceTimersByTime(31 * 60 * 1000);
  expect(consumeSkillSourceReturn("company-a")).toBeNull();
  rememberSkillSourceReturn("company-a", "https://example.com");
  expect(skillSourceReturnPath("company-a")).toBeNull();
  sessionStorage.setItem("paperclip.skill-source-connect-return:company-a", JSON.stringify({ sourceId: "//example.com", expiresAt: Date.now() + 1000 }));
  expect(consumeSkillSourceReturn("company-a")).toBeNull();
});
