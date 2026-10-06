// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { TaskChatSkillCreatedCard } from "./TaskChatSkillCreatedCard";
import { i18n } from "@/i18n";

describe("TaskChatSkillCreatedCard", () => {
  it("keeps persisted skill identity while localizing its card through ru → en → ru", async () => {
    const onOpen = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const item = { id: "skill-created:1", kind: "skill_created" as const, skillId: "skill-1", name: "Release helper", description: "Original skill description", timestamp: "2026-09-16T12:00:00Z" };
    const original = structuredClone(item);
    try {
      act(() => root.render(<TaskChatSkillCreatedCard item={item} onOpen={onOpen} />));
      const button = container.querySelector("button")!;
      for (const language of ["ru", "en", "ru"]) {
        await act(async () => { await i18n.changeLanguage(language); });
        expect(container.querySelector("button")).toBe(button);
        expect(container.querySelector("article")?.getAttribute("aria-label")).toBe(
          language === "ru" ? "Создан навык: Release helper" : "Skill created: Release helper",
        );
        expect(container.textContent).toContain(language === "ru" ? "Навык создан" : "Skill created");
        expect(container.textContent).toContain("Original skill description");
        act(() => button.click());
        expect(onOpen).toHaveBeenLastCalledWith("skill-1", "Release helper");
        expect(item).toEqual(original);
      }
      expect(onOpen).toHaveBeenCalledTimes(3);
    } finally {
      act(() => root.unmount());
      container.remove();
      await act(async () => { await i18n.changeLanguage("en"); });
    }
  });
});
