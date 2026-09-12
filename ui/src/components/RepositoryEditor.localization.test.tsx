// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProjectRepository } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { RepositoryEditor } from "./RepositoryEditor";

const repo: ProjectRepository = {
  id: "repository-17", fullName: "Board/Save changes", url: "https://github.com/example/project",
  private: true, connections: ["Your GitHub", "Рабочий аккаунт"],
};

// Test the editor's display contract without depending on popover positioning in jsdom.
vi.mock("./SearchableSelect", () => ({
  SearchableSelect: ({ loading, loadingMessage, emptyMessage, createItem }: {
    loading: boolean; loadingMessage: string; emptyMessage: string;
    createItem: { render: () => React.ReactNode; onSelect: () => void };
  }) => <div><p>{loading ? loadingMessage : emptyMessage}</p><button onClick={createItem.onSelect}>{createItem.render()}</button></div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("repository editor localization", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await i18n.changeLanguage("en");
  });

  it("retranslates selected rows without changing draft selection, repository names, or connection names", async () => {
    const changed = vi.fn();
    const connect = vi.fn();
    function Draft() {
      const [selected, setSelected] = useState([repo]);
      return <RepositoryEditor selected={selected} onChange={(next) => { changed(next); setSelected(next); }} onConnect={connect} onRetry={vi.fn()} />;
    }
    await act(async () => root.render(<Draft />));
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove Board/Save changes"]')!;
    expect(remove).not.toBeNull();
    for (const locale of ["ru", "en", "ru"]) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(remove.getAttribute("aria-label")).toBe(locale === "ru" ? "Убрать Board/Save changes" : "Remove Board/Save changes");
      expect(container.textContent).toContain("Board/Save changes");
      expect(container.textContent).toContain("Your GitHub · Рабочий аккаунт");
      expect(container.textContent).toContain(locale === "ru" ? "Добавить ещё репозиторий" : "Add another repo");
      expect(changed).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
    }
    await act(async () => remove.click());
    expect(changed).toHaveBeenCalledExactlyOnceWith([]);
    expect(container.textContent).not.toContain(repo.fullName);
    expect(container.textContent).toContain("Добавить репозиторий GitHub");
  });

  it.each([
    ["loading", "Loading GitHub repos…", "Загружаем репозитории GitHub…"],
    ["error", "Couldn’t load GitHub repos. Try again.", "Не удалось загрузить репозитории GitHub. Повторите попытку."],
    ["empty", "No repos available. Connect an account with repo access.", "Нет доступных репозиториев. Подключите аккаунт с доступом к репозиториям."],
    ["ready", "No matching repos. Try another search or connection.", "Подходящих репозиториев нет. Измените запрос или выберите другое подключение."],
  ] as const)("retranslates the open %s state without retrying or reconnecting", async (state, english, russian) => {
    const retry = vi.fn();
    const connect = vi.fn();
    await act(async () => root.render(<RepositoryEditor selected={[]} onChange={vi.fn()} onConnect={connect} onRetry={retry} state={state} />));
    await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain(english);
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain(russian);
    expect(retry).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
