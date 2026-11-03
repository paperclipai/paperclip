// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { CompanyUserDirectoryEntry } from "@/api/access";
import { i18n } from "@/i18n";
import { RunIdentityHistory } from "./RunIdentityHistory";

type HistoryEntry = NonNullable<HeartbeatRun["identityHistory"]>[number];

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: "identity-raw", revision: 1, responsibleUserId: "person-raw", messageId: "message-raw",
    parentContextId: null, cause: "instruction", status: "accepted", acceptedAt: "2026-09-01T12:00:00Z",
    github: { status: "available", source: "personal", login: "Board" },
    ...overrides,
  };
}

describe("run identity history localization", () => {
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

  it.each([undefined, null, []])("does not add a history section for %s", async (history) => {
    await act(async () => root.render(<RunIdentityHistory history={history} />));
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(container.innerHTML).toBe("");
    }
  });

  it.each(["Board", "You"])("preserves real name %s, logins and expanded history through EN → RU → EN", async (name) => {
    const users: CompanyUserDirectoryEntry[] = [{
      principalId: "person-raw", status: "active",
      user: { id: "person-raw", name, email: "keep@example.test", image: null },
    }];
    const history = [
      entry(),
      entry({ id: "identity-pending", revision: 2, cause: "steering", status: "pending", github: {
        status: "unavailable", source: "dedicated", login: "You",
        reason: "The managed GitHub identity must be reconnected",
      } }),
      entry({ id: "identity-rejected", revision: 3, cause: "company_default", status: "rejected", github: {
        status: "absent", source: "personal", reason: "No GitHub identity connected",
      } }),
      entry({ id: "identity-no-person", revision: 4, responsibleUserId: null, cause: "dispatch", github: null }),
    ];
    const original = JSON.stringify({ history, users });
    await act(async () => root.render(<RunIdentityHistory history={history} users={users} />));
    const details = container.querySelector("details")!;
    const summary = container.querySelector("summary")!;
    const rows = [...container.querySelectorAll("li")];
    await act(async () => summary.click());
    expect(details.open).toBe(true);

    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      const russian = language === "ru";
      expect(container.querySelector("details")).toBe(details);
      expect(container.querySelector("summary")).toBe(summary);
      expect([...container.querySelectorAll("li")]).toEqual(rows);
      expect(details.open).toBe(true);
      expect(summary.textContent).toBe(russian ? "История выбора аккаунта GitHub" : "GitHub identity history");
      expect(rows[0].querySelector("span")?.textContent?.trim()).toBe(name);
      expect(rows[0].textContent).toContain(russian ? "Инструкция · Принято" : "Instruction · Accepted");
      expect(rows[0].textContent).toContain(russian ? "@Board · Личный аккаунт · Доступен" : "@Board · Personal account · Available");
      expect(rows[1].textContent).toContain(russian ? "Уточнение инструкций · Ожидание" : "Steering · Pending");
      expect(rows[1].textContent).toContain(russian ? "@You · Выделенный аккаунт агента · Недоступен" : "@You · Dedicated agent account · Unavailable");
      expect(rows[1].textContent).toContain(russian ? "Управляемый аккаунт GitHub нужно подключить заново" : "The managed GitHub identity must be reconnected");
      expect(rows[2].textContent).toContain(russian ? "По умолчанию для компании · Отклонено" : "Company default · Rejected");
      expect(rows[2].textContent).toContain(russian ? "Отсутствует: Аккаунт GitHub не подключён" : "Absent: No GitHub identity connected");
      expect(rows[3].textContent).toContain(russian ? "Ответственный не указан" : "No responsible person");
      expect(rows[3].textContent).toContain(russian ? "Операции GitHub не зафиксированы" : "No GitHub operation recorded");
      expect(JSON.stringify({ history, users })).toBe(original);
    }
  });

  it("preserves email, missing-user IDs and unknown values without treating them as translation keys", async () => {
    const users: CompanyUserDirectoryEntry[] = [
      { principalId: "email-user", status: "active", user: { id: "email-user", name: null, email: "Board@example.test", image: null } },
      { principalId: "null-user", status: "active", user: null },
    ];
    const unknown = entry({
      id: "unknown", responsibleUserId: "missing-user", cause: "custom_plugin_wake", status: "future_status",
      github: { status: "future_github_status", source: "external_sso", login: "You", reason: "No GitHub identity connected: custom reason" } as unknown as HistoryEntry["github"],
    });
    const history = [entry({ responsibleUserId: "email-user" }), entry({ id: "null", responsibleUserId: "null-user" }), unknown];
    const original = JSON.stringify({ history, users });
    await act(async () => root.render(<RunIdentityHistory history={history} users={users} />));

    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      const rows = [...container.querySelectorAll("li")];
      expect(rows[0].querySelector("span")?.textContent?.trim()).toBe("Board@example.test");
      expect(rows[1].querySelector("span")?.textContent?.trim()).toBe("null-user");
      expect(rows[2].textContent).toContain("missing-user · custom_plugin_wake · future_status");
      expect(rows[2].textContent).toContain("@You · external_sso · future_github_status: No GitHub identity connected: custom reason");
      expect(JSON.stringify({ history, users })).toBe(original);
    }
  });

  it.each([
    ["No GitHub identity connected", "Аккаунт GitHub не подключён"],
    ["GitHub credentials are temporarily unavailable", "Учётные данные GitHub временно недоступны"],
    ["No managed GitHub identity is available for this run", "Для этого запуска нет доступного управляемого аккаунта GitHub"],
    ["More than one managed GitHub identity matches this run", "Для запуска подходят несколько управляемых аккаунтов GitHub"],
    ["The managed GitHub connection is unavailable", "Управляемое подключение GitHub недоступно"],
    ["The managed GitHub identity must be reconnected", "Управляемый аккаунт GitHub нужно подключить заново"],
    ["The managed GitHub identity owner is not an authorized company member", "У владельца управляемого аккаунта GitHub нет необходимых прав в компании"],
    ["The managed GitHub identity is incomplete", "Данные управляемого аккаунта GitHub неполны"],
    ["The managed GitHub identity no longer has repository access", "Управляемый аккаунт GitHub больше не имеет доступа к репозиториям"],
    ["The personal GitHub credential cannot be resolved", "Не удалось получить личные учётные данные GitHub"],
    ["The personal GitHub credential is invalid", "Личные учётные данные GitHub недействительны"],
    ["The personal GitHub credential is missing", "Личные учётные данные GitHub отсутствуют"],
  ])("localizes the product diagnostic %s at display time", async (reason, russian) => {
    const history = [entry({ github: { status: "unavailable", reason } })];
    await act(async () => root.render(<RunIdentityHistory history={history} />));
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(container.querySelector("li > .block")?.textContent).toBe(`${language === "ru" ? "Недоступен" : "Unavailable"}: ${language === "ru" ? russian : reason}`);
      expect(history[0].github?.reason).toBe(reason);
    }
  });

  it("localizes recognized wake reasons used as identity causes", async () => {
    const history = [
      entry({ id: "comment", cause: "issue_commented" }),
      entry({ id: "timer", cause: "heartbeat_timer" }),
      entry({ id: "retry", cause: "process_lost_retry" }),
    ];
    await act(async () => root.render(<RunIdentityHistory history={history} />));
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      const rows = [...container.querySelectorAll("li")];
      expect(rows[0].textContent).toContain(language === "ru" ? "Комментарий к задаче" : "Task comment");
      expect(rows[1].textContent).toContain(language === "ru" ? "Таймер планового запуска" : "Heartbeat timer");
      expect(rows[2].textContent).toContain(language === "ru" ? "Повторная попытка после потери процесса" : "Retry after process loss");
    }
  });
});
