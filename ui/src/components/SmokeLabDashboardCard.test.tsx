// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmokeLabDashboardCard } from "./SmokeLabDashboardCard";

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

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

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

  beforeEach(() => {
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

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
});
