// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { MemoryRouter } from "@/lib/router";
import { ThemeProvider } from "@/context/ThemeContext";
import { credentialAccessNotice } from "@/lib/credential-access-notice";
import { resolveIssueChatHumanAuthorDisplay as resolveIssueChatHumanAuthor } from "@/lib/issue-chat-human-author";
import type { IssueChatLinkedRun } from "@/lib/issue-chat-messages";
import { TaskChatMarker } from "./TaskChatMarker";
import { taskChatDisplayLabel, taskThreadMarkerDetailDisplay } from "./task-chat-display";
import { IssuePullRequestLinks } from "../IssuePullRequestLinks";
import type { IssueWorkProduct } from "@paperclipai/shared";
import type { ExternalObjectPillData } from "../ExternalObjectPill";

vi.mock("@/lib/router", async () => import("react-router-dom"));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deniedRun = {
  runId: "run/raw-id", agentId: "agent/raw-id", agentName: "", status: "failed",
  createdAt: "2026-10-19T10:00:00Z", startedAt: null, responsibleUserId: "u-raw",
  resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared" } },
} as IssueChatLinkedRun;

describe("October 19 task display boundaries", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    await i18n.changeLanguage("en");
  });

  it("updates generated credential fallbacks without changing canonical identities or links", async () => {
    const source = JSON.stringify(deniedRun);
    const credentialAccess = credentialAccessNotice(deniedRun, "viewer")!;
    const item = { id: "credential", kind: "marker" as const, variant: "interrupted" as const,
      label: "Run failed", runHref: "/agents/agent/raw-id/runs/run/raw-id", credentialAccess };
    const before = JSON.stringify(item);
    await act(async () => root.render(<MemoryRouter><ThemeProvider><TaskChatMarker item={item} /></ThemeProvider></MemoryRouter>));
    const notice = host.querySelector('[data-testid="task-chat-credential-access-notice"]');
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.querySelector('[data-testid="task-chat-credential-access-notice"]')).toBe(notice);
      expect(notice?.textContent).toContain(language === "ru" ? "Этот агент" : "This agent");
      expect(notice?.textContent).toContain(language === "ru" ? "человека, от имени которого выполняется задача" : "the person this task runs for");
      if (language === "ru") {
        expect(notice?.textContent).toContain("Этот агент не смог начать работу");
        expect(notice?.textContent).toContain("на использование учётных данных ИИ");
        expect(notice?.textContent).toContain("доступное человеку, от имени которого выполняется задача");
        expect(notice?.textContent).toContain("подключение этого агента");
        expect(notice?.textContent).not.toContain("агента Этот агент");
      }
      expect(notice?.querySelector("a")?.getAttribute("href")).toBe("/agents/agent%2Fraw-id/runtime");
      expect(JSON.stringify(item)).toBe(before);
      expect(JSON.stringify(deniedRun)).toBe(source);
    }
  });

  it.each(["the person this task runs for", "you"])("preserves real names matching fallback text: %s", async (name) => {
    const run = { ...deniedRun, agentName: "This agent", resultJson: {
      configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
        credentialAccess: { connectionName: "Unknown Provider Key / RAW" } },
    } };
    const credentialAccess = credentialAccessNotice(run, "viewer", new Map([["u-raw", name]]))!;
    expect(credentialAccess).toMatchObject({ agentNameIsFallback: false, deniedUserKind: "named" });
    await act(async () => {
      await i18n.changeLanguage("ru");
      root.render(<MemoryRouter><ThemeProvider><TaskChatMarker item={{
        id: "named", kind: "marker", variant: "interrupted", label: "Run failed", credentialAccess,
      }} /></ThemeProvider></MemoryRouter>);
    });
    expect(host.textContent).toContain("This agent");
    expect(host.textContent).toContain(name);
    expect(host.textContent).toContain("Unknown Provider Key / RAW");
    expect(host.textContent).toContain("Агент This agent настроен на использование Unknown Provider Key / RAW");
    expect(host.textContent).toContain(`у пользователя ${name} нет доступа`);
    expect(host.textContent).toContain(`доступное пользователю ${name}`);
    expect(host.textContent).toContain("подключение агента This agent");
    expect(host.textContent).not.toContain("Этот агент");
  });

  it("translates only generated author and exact platform display values", async () => {
    await i18n.changeLanguage("ru");
    const named = { label: "Board", image: "/api/assets/raw-id/content" };
    expect(resolveIssueChatHumanAuthor({ authorUserId: "local-board", userProfileMap: new Map([["local-board", named]]) }))
      .toMatchObject({ authorName: "Board", avatarUrl: named.image, isCurrentUser: false });
    expect(resolveIssueChatHumanAuthor({ authorUserId: "u-raw", currentUserId: "u-raw" }).authorName).toBe("Вы");
    expect(resolveIssueChatHumanAuthor({ authorName: "Actual raw name", authorUserId: "u-raw" }).authorName).toBe("Actual raw name");
    expect(taskChatDisplayLabel("Waiting for Muse")).toBe("Ожидание Muse");
    expect(taskChatDisplayLabel("Waiting for Raw Custom Provider")).toBe("Waiting for Raw Custom Provider");
    expect(taskThreadMarkerDetailDisplay("Provider RAW: keep this response unchanged")).toBe("Provider RAW: keep this response unchanged");
  });

  it("keeps a closed PR terminal when its category fallback changes language", async () => {
    const product = { id: "pr-raw", type: "pull_request", status: "active", title: "Raw PR title",
      metadata: { state: "open" }, reviewState: "needs_board_review", url: "https://github.com/raw/repo/pull/9" } as unknown as IssueWorkProduct;
    const external = { providerKey: "github", objectType: "pull_request", statusCategory: "closed",
      statusLabel: null, statusIconKey: null, liveness: "fresh", url: "https://github.com/raw/repo/pull/9" } as unknown as ExternalObjectPillData;
    const before = JSON.stringify([product, external]);
    await act(async () => root.render(<IssuePullRequestLinks products={[product]} externalObjects={[external]} />));
    for (const language of ["en", "ru", "en"]) {
      await act(async () => { await i18n.changeLanguage(language); });
      expect(host.textContent).not.toContain(language === "ru" ? "Запрошена проверка" : "Review requested");
      expect(JSON.stringify([product, external])).toBe(before);
    }
  });
});
