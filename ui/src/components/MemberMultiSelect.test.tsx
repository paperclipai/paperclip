// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { MemberMultiSelect } from "./MemberMultiSelect";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("MemberMultiSelect localization", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it("keeps staged IDs, filter text, and custom member values through a language switch", async () => {
    const members = [{ userId: "user-id", name: "Alex", email: "alex@example.com" }];
    const onSave = vi.fn();
    await act(async () => {
      root.render(<MemberMultiSelect members={members} selectedUserIds={new Set()} onSave={onSave} />);
    });
    await act(async () => container.querySelector("button")!.click());
    const filter = document.querySelector<HTMLInputElement>('input[placeholder="Filter people"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(filter, "alex");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const checkbox = document.querySelector<HTMLButtonElement>('[aria-label="Allow Alex"]')!;
    await act(async () => checkbox.click());
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(checkbox.getAttribute("aria-label")).toBe("Разрешить доступ: Alex");
    expect(filter.value).toBe("alex");
    expect(filter.placeholder).toBe("Поиск людей");
    expect(document.body.textContent).toContain("alex@example.com");
    expect(document.body.textContent).toContain("Выбрано: 1");
    expect(onSave).not.toHaveBeenCalled();
    const save = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "Сохранить")!;
    await act(async () => save.click());
    expect(onSave).toHaveBeenCalledExactlyOnceWith(new Set(["user-id"]));
  });

  it.each([[1, "Выбран 1 человек"], [2, "Выбрано 2 человека"], [5, "Выбрано 5 человек"], [11, "Выбрано 11 человек"], [21, "Выбран 21 человек"]] as const)("renders Russian person plurals for %s", async (count, expected) => {
    await i18n.changeLanguage("ru");
    await act(async () => {
      root.render(<MemberMultiSelect members={[]} selectedUserIds={new Set(Array.from({ length: count }, (_, i) => String(i)))} />);
    });
    expect(container.textContent).toBe(expected);
  });
});
