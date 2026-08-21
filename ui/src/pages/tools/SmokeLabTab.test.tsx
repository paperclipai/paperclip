// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmokeLabTab } from "./SmokeLabTab";

const getExperimentalMock = vi.hoisted(() => vi.fn());
const listServicesMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const getRunMock = vi.hoisted(() => vi.fn());
const createRunMock = vi.hoisted(() => vi.fn());
const startServicesMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: { getExperimental: () => getExperimentalMock() },
}));

vi.mock("@/api/smokeLab", () => ({
  smokeLabApi: {
    listServices: (c: string) => listServicesMock(c),
    listRuns: (c: string) => listRunsMock(c),
    getRun: (c: string, r: string) => getRunMock(c, r),
    createRun: (c: string, i: unknown) => createRunMock(c, i),
    startServices: (c: string) => startServicesMock(c),
    stopServices: vi.fn(),
    installFixtures: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
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
  status: "passed",
  startedAt: "2026-07-10T00:00:00Z",
  finishedAt: "2026-07-10T00:05:00Z",
  summary: {},
  createdAt: "2026-07-10T00:00:00Z",
  updatedAt: "2026-07-10T00:05:00Z",
};

const STEPS = [
  {
    id: "s1",
    companyId: "company-1",
    runId: "run-1",
    path: "P1",
    scenarioStep: "oauth-login",
    status: "pass",
    detail: "Signed in via fake OAuth consent page",
    screenshotArtifactRef: null,
    durationMs: 812,
    createdAt: "2026-07-10T00:00:01Z",
    updatedAt: "2026-07-10T00:00:01Z",
  },
  {
    id: "s2",
    companyId: "company-1",
    runId: "run-1",
    path: "P7",
    scenarioStep: "schema-change-quarantine",
    status: "fail",
    detail: "Quarantine not enforced",
    screenshotArtifactRef: null,
    durationMs: 240,
    createdAt: "2026-07-10T00:00:02Z",
    updatedAt: "2026-07-10T00:00:02Z",
  },
];

describe("SmokeLabTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    getExperimentalMock.mockResolvedValue({ enableSmokeLab: true });
    listServicesMock.mockResolvedValue({
      services: [
        {
          id: "fake-oauth",
          label: "Fake OAuth 2.0 provider",
          status: "running",
          url: "http://127.0.0.1:3100/api/companies/company-1/smoke-lab/oauth/authorize",
          health: { ok: true },
          detail: "In-process deterministic OAuth provider.",
        },
      ],
    });
    listRunsMock.mockResolvedValue({ runs: [RUN] });
    getRunMock.mockResolvedValue({ run: RUN, steps: STEPS });
    createRunMock.mockResolvedValue({ run: { ...RUN, id: "run-2", status: "running" } });
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
          <SmokeLabTab companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("hides the lab and shows a flag-off notice when the flag is disabled", async () => {
    getExperimentalMock.mockResolvedValue({ enableSmokeLab: false });
    await render();

    expect(container.textContent).toContain("Smoke Lab is turned off");
    expect(container.querySelector('[data-testid="smoke-lab-tab"]')).toBeNull();
    expect(container.textContent).not.toContain("Integration matrix");
    expect(listServicesMock).not.toHaveBeenCalled();
  });

  it("renders services with the resolved URL, demo credentials, and the P1–P7 matrix when enabled", async () => {
    await render();

    expect(container.querySelector('[data-testid="smoke-lab-tab"]')).not.toBeNull();
    // Resolved URL printed verbatim — never an assumed port.
    expect(container.textContent).toContain(
      "http://127.0.0.1:3100/api/companies/company-1/smoke-lab/oauth/authorize",
    );
    // Demo credentials for the fake OAuth login.
    expect(container.textContent).toContain("smoke@paperclip.test");
    expect(container.textContent).toContain("smoke-password");
    // Matrix rows for every path + a governed lifecycle column.
    expect(container.textContent).toContain("Integration matrix");
    expect(container.textContent).toContain("Remote HTTP · OAuth");
    expect(container.textContent).toContain("Governance surfaces");
    expect(container.textContent).toContain("Schema-change quarantine");
    // Failing path surfaced from the recorded steps.
    expect(container.textContent).toContain("failing: P7");
    // Step drill-down shows the raw scenario step.
    expect(container.textContent).toContain("oauth-login");
  });

  it("starts a manual run when 'Run browser smoke now' is clicked", async () => {
    await render();

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Run browser smoke now"),
    );
    expect(runButton).toBeTruthy();

    await act(async () => {
      runButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(createRunMock).toHaveBeenCalledWith("company-1", { trigger: "manual", summary: {} });
  });
});
