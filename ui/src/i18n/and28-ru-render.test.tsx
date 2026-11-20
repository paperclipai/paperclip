// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LOCALE_STORAGE_KEY } from "@/i18n/preference";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "@/pages/CompanySettings";

const company = {
  id: "company-1",
  name: "Acme Robotics",
  description: "",
  status: "active",
  issuePrefix: "ACM",
  brandColor: null,
  logoUrl: "https://example.test/logo.png",
  attachmentMaxBytes: null,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
};

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [company],
    selectedCompany: company,
    selectedCompanyId: company.id,
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("@/api/companies", () => ({
  companiesApi: { update: vi.fn(), archive: vi.fn() },
}));

vi.mock("@/api/assets", () => ({
  assetsApi: { uploadCompanyLogo: vi.fn() },
}));

vi.mock("@/api/health", () => ({
  healthApi: { get: vi.fn() },
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getGeneral: vi.fn(),
    updateGeneral: vi.fn(),
  },
}));

vi.mock("@/api/agent-observability", () => ({
  agentObservabilityApi: { settings: vi.fn() },
}));

vi.mock("@/api/auth", () => ({
  authApi: { signOut: vi.fn() },
}));

import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { agentObservabilityApi } from "@/api/agent-observability";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("company general settings in Russian", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "ru");
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.mocked(healthApi.get).mockResolvedValue({
      status: "ok",
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      authReady: false,
      bootstrapStatus: "ready",
      bootstrapInviteActive: false,
      hiddenSettings: [],
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme",
        cloudBaseUrl: "https://cloud.example.test",
      },
    } as never);
    vi.mocked(instanceSettingsApi.getGeneral).mockResolvedValue({
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
      backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    } as never);
    vi.mocked(agentObservabilityApi.settings).mockResolvedValue({
      canManage: true,
      settings: {
        companyId: company.id,
        revision: "20000000-0000-4000-8000-000000000001",
        enabled: false,
        destination: { provider: "braintrust", projectId: "30000000-0000-4000-8000-000000000001" },
        capture: { userPrompts: true, assistantResponses: true, toolDetails: true, toolContent: true },
        credentialsConfigured: true,
        headerNames: [],
        updatedAt: "2026-10-19T12:00:00Z",
        lastTest: {
          revision: "20000000-0000-4000-8000-000000000001",
          marker: "m",
          source: "control_plane",
          startedAt: "2026-10-19T12:00:00Z",
          finishedAt: "2026-10-19T12:00:01Z",
          status: "failed",
          signals: {
            logs: { status: "failed", httpStatus: 400, rejectedRecords: 0, errorCode: null, message: "nope", durationMs: 1 },
            traces: { status: "failed", httpStatus: 400, rejectedRecords: 0, errorCode: null, message: "nope", durationMs: 1 },
          },
        },
      },
    } as never);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    localStorage.removeItem(LOCALE_STORAGE_KEY);
    root = null;
  });

  it("reads the general settings screen from the Russian dictionary", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      cloud: {
        managed: true,
        managedBy: "paperclip-cloud",
        stackSlug: "acme",
        cloudBaseUrl: "https://cloud.example.test",
      },
    });
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <MemoryRouter>
              <CompanySettings />
            </MemoryRouter>
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Наблюдаемость агентов");
      expect(container.textContent).toContain("Хранение резервных копий");
    });

    const text = container.textContent ?? "";
    for (const phrase of [
      "Общие",
      "Имя компании",
      "Переименование может сменить префикс ID задач этой компании.",
      "Оформление",
      "Убрать логотип",
      "Найм",
      "Требовать одобрение доски для найма",
      "Управление взаимодействиями",
      "Взаимодействия в ветке по умолчанию открыты:",
      "Любой",
      "в компании — доска или любой агент, в том числе тот, кто спросил, — может ответить.",
      "Политика по умолчанию",
      "Ограничение",
      "Только человек",
      "Предложенные задачи",
      "Любой (по умолчанию)",
      "Без ограничения",
      "Отправляйте данные выполнения Codex, Claude Code и встроенного OpenCode",
      "Ключ API задан",
      "Заменить ключ API",
      "Промпты пользователя",
      "Тестовые данные не прошли",
      "Отправлено с сервера Paperclip",
      "Трейсы",
      "Развёртывание и аутентификация",
      "Закрытый режим с аутентификацией требует входа",
      "Готовность аутентификации",
      "Не готово",
      "Статус начальной настройки",
      "Скрывать имя пользователя в журналах",
      "По дням",
      "По неделям",
      "Отправка отзывов ИИ",
      "Прочитать условия использования",
      "Выбор по умолчанию ещё не сохранён.",
      "Отправлять оценённые ответы ИИ автоматически.",
      "Оставлять оценённые ответы ИИ только локально.",
      "Чтобы снова вызвать первый запрос в локальной разработке, удалите ключ",
      "feedbackDataSharingPreference",
      "из JSON-строки",
      "instance_settings.general",
      "этого инстанса или верните значение",
      "Пустое значение и",
      "означают, что выбор по умолчанию ещё не сделан.",
      "Выйти из этого инстанса Paperclip.",
      "Опасная зона",
      "Архивируйте компанию, чтобы скрыть её из боковой панели.",
      "Архивировать компанию",
    ]) {
      expect(text, phrase).toContain(phrase);
    }

    const description = container.querySelector<HTMLInputElement>('input[placeholder="Необязательное описание компании"]');
    expect(description).not.toBeNull();
    expect(container.querySelector('[aria-label="Переключить скрытие имени пользователя в журналах"]')).not.toBeNull();
    expect(text).not.toContain("Archive organization");
    expect(text).not.toContain("Agent observability");
    expect(text).not.toContain("Interaction governance");
  });
});
