// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmokeLabDashboardCard } from "./SmokeLabDashboardCard";
import { i18n } from "@/i18n";

const getExperimentalMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: () => getExperimentalMock() },
}));

vi.mock("@/api/smokeLab", () => ({
  smokeLabApi: {
    listRuns: (c: string) => listRunsMock(c),
    getRun: (c: string, r: string) => getRunMock(c, r),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

const RUN = {
  id: "run-1",
  companyId: "company-1",
  trigger: "manual",
  status: "failed",
  startedAt: "2026-07-10T00:00:00Z",
  finishedAt: "2026-07-10T00:05:00Z",
  summary: {},
  createdAt: "2026-07-10T00:00:00Z",
  updatedAt: "2026-07-10T00:05:00Z",
};

describe("SmokeLabDashboardCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    container = document.createElement("div");
    document.body.appendChild(container);
    getExperimentalMock.mockResolvedValue({ enableSmokeLab: true });
    listRunsMock.mockResolvedValue({ runs: [RUN] });
    getRunMock.mockResolvedValue({
      run: RUN,
      steps: [
        {
          id: "s1",
          companyId: "company-1",
          runId: "run-1",
          path: "P3",
          scenarioStep: "allowed-read",
          status: "fail",
          detail: null,
          screenshotArtifactRef: null,
          durationMs: null,
          createdAt: "2026-07-10T00:00:01Z",
          updatedAt: "2026-07-10T00:00:01Z",
        },
      ],
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    client?.clear();
    container.remove();
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
  });

  async function render() {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SmokeLabDashboardCard companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders nothing when the flag is off", async () => {
    getExperimentalMock.mockResolvedValue({ enableSmokeLab: false });
    await render();

    expect(container.querySelector('[data-testid="smoke-lab-dashboard-card"]')).toBeNull();
    expect(container.textContent).not.toContain("Integration smoke");
    expect(listRunsMock).not.toHaveBeenCalled();
  });

  it("renders the card with failing paths and a link to the Smoke Lab tab when enabled", async () => {
    await render();

    const card = container.querySelector<HTMLAnchorElement>('[data-testid="smoke-lab-dashboard-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("href")).toBe("/apps/advanced/smoke-lab");
    expect(container.textContent).toContain("Integration smoke");
    expect(container.textContent).toContain("Failing paths: P3");
  });

  it.each([
    { health: "green", status: "passed", stepStatus: "pass", en: "All paths passing", ru: "Все варианты подключения прошли проверку" },
    { health: "amber", status: "running", stepStatus: "pass", en: "Needs a run", ru: "Нужно запустить проверку" },
    { health: "red", status: "failed", stepStatus: "fail", en: "Failing paths: P3", ru: "Не прошли проверку: P3" },
    { health: "unknown", status: null, stepStatus: null, en: "No runs yet", ru: "Запусков пока нет" },
  ])("reactively translates $health health, title and date without refetching or changing canonical run data", async ({ health, status, stepStatus, en, ru }) => {
    const run = status ? { ...RUN, status } : undefined;
    const detail = {
      run,
      steps: stepStatus ? [{
        id: "raw-step-1", companyId: "company-1", runId: "run-1", path: "P3",
        scenarioStep: "allowed-read", status: stepStatus, detail: null,
        screenshotArtifactRef: null, durationMs: null,
        createdAt: RUN.startedAt, updatedAt: RUN.startedAt,
      }] : [],
    };
    const original = JSON.stringify(detail);
    listRunsMock.mockResolvedValue({ runs: run ? [run] : [] });
    getRunMock.mockResolvedValue(detail);
    await render();
    const card = container.querySelector<HTMLAnchorElement>('[data-testid="smoke-lab-dashboard-card"]')!;
    expect(card).not.toBeNull();

    for (const [locale, title, healthText, hint] of [
      ["en", "Integration smoke", en, "Run one from the Smoke Lab tab"],
      ["ru", "Базовая проверка интеграций", ru, "Запустите проверку на вкладке «Лаборатория smoke-тестов»"],
      ["en", "Integration smoke", en, "Run one from the Smoke Lab tab"],
    ] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector('[data-testid="smoke-lab-dashboard-card"]')).toBe(card);
      expect(card.getAttribute("href")).toBe("/apps/advanced/smoke-lab");
      expect(card.textContent).toContain(title);
      expect(card.textContent).toContain(healthText);
      if (run) {
        const time = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(RUN.startedAt));
        expect(card.textContent).toContain(locale === "ru" ? `Последний запуск: ${time}` : `Last run ${time}`);
      } else {
        expect(card.textContent).toContain(hint);
      }
      expect(getExperimentalMock).toHaveBeenCalledTimes(1);
      expect(listRunsMock).toHaveBeenCalledExactlyOnceWith("company-1");
      if (health === "unknown") expect(getRunMock).not.toHaveBeenCalled();
      else expect(getRunMock).toHaveBeenCalledExactlyOnceWith("company-1", "run-1");
      expect(JSON.stringify(detail)).toBe(original);
    }
  });
});
