// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkspaceOperation } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n, t, useTranslation } from "@/i18n";
import { WorkspaceServiceControlBar } from "./WorkspaceServiceControlBar";
import { WorkspaceAccessCard } from "./WorkspaceAccessCard";
import { resolveWorkspaceAccessState } from "../lib/workspace-access-state";
import { buildReusableExecutionWorkspaceOptionGroups } from "../lib/reusable-execution-workspaces";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  void i18n.changeLanguage("en");
});

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
}

describe("Workspace localization", () => {
  it.each([
    [1, "Найден 1 элемент."],
    [2, "Найдено 2 элемента."],
    [5, "Найдено 5 элементов."],
    [21, "Найден 21 элемент."],
    [22, "Найдено 22 элемента."],
    [25, "Найдено 25 элементов."],
  ])("uses Russian search-result forms for %i", (count, expected) => {
    void i18n.changeLanguage("ru");
    expect(t("localizationWorkspaces.itemsFound", { count })).toBe(expected);
  });

  it("switches a mounted service bar while preserving the URL and action identifiers", () => {
    mount();
    const onAction = vi.fn();
    const services = [{ key: "web-id", name: "User service", state: "running" as const, url: "http://127.0.0.1:3100" }];
    act(() => root?.render(<WorkspaceServiceControlBar services={services} onAction={onAction} />));
    expect(container?.textContent).toContain("Running");
    expect(container?.querySelector('button[aria-label="Copy URL"]')).not.toBeNull();
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container?.textContent).toContain("Запущена");
    expect(container?.querySelector('button[aria-label="Скопировать URL"]')).not.toBeNull();
    expect(container?.querySelector("a")?.getAttribute("href")).toBe("http://127.0.0.1:3100");
    const stop = container?.querySelector<HTMLButtonElement>('button[aria-label="Остановить"]');
    expect(stop).not.toBeNull();
    act(() => stop?.click());
    expect(onAction).toHaveBeenCalledWith("stop", "web-id");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container?.textContent).toContain("Running");
    expect(container?.querySelector('button[aria-label="Copy URL"]')).not.toBeNull();
  });

  it("refreshes recovery copy and group labels without translating phase, branch, path, or identity", () => {
    mount();
    const operation: WorkspaceOperation = {
      id: "repair-id", phase: "workspace_repair", status: "failed",
      metadata: { repairPhase: "managed_restart" }, finishedAt: null,
      companyId: "company-id", executionWorkspaceId: "raw-workspace",
      heartbeatRunId: null, issueId: null, command: null, cwd: null,
      exitCode: 1, logStore: null, logRef: null, logBytes: null,
      logSha256: null, logCompressed: false, stdoutExcerpt: null,
      stderrExcerpt: null, startedAt: new Date("2026-08-19T00:00:00Z"),
      createdAt: new Date("2026-08-19T00:00:00Z"), updatedAt: new Date("2026-08-19T00:00:00Z"),
    };
    const workspace = { id: "raw-workspace", name: "User workspace", cwd: "/srv/worktree", branchName: "feature/raw", lastUsedAt: "2026-08-19T00:00:00Z" };
    const groups = buildReusableExecutionWorkspaceOptionGroups([workspace], { now: workspace.lastUsedAt });
    function Recovery() {
      useTranslation();
      return <WorkspaceAccessCard
        access={resolveWorkspaceAccessState({ operations: [operation], runtimeServices: [] })}
        onOpen={() => {}} onStart={() => {}} onRepair={() => {}} onViewLogs={() => {}}
      />;
    }
    act(() => root?.render(<Recovery />));
    expect(container?.textContent).toContain("Repair failed");
    expect(container?.textContent).toContain("managed_restart");
    expect(groups[0]?.label).toBe("Recent");
    act(() => { void i18n.changeLanguage("ru"); });
    expect(container?.textContent).toContain("Восстановление завершилось ошибкой");
    expect(container?.textContent).toContain("managed_restart");
    expect(container?.textContent).toContain("Резервная копия, созданная перед восстановлением, сохранена.");
    expect(groups[0]?.label).toBe("Недавние");
    expect(groups[0]?.options[0]).toMatchObject({ value: "raw-workspace", label: "User workspace", description: "feature/raw", workspace });
    expect(operation.metadata?.repairPhase).toBe("managed_restart");
    act(() => { void i18n.changeLanguage("en"); });
    expect(container?.textContent).toContain("Repair failed");
    expect(groups[0]?.label).toBe("Recent");
  });
});
