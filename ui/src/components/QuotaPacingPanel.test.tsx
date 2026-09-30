// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { QuotaPacingSettings, QuotaPacingState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaPacingPanel } from "./QuotaPacingPanel";

const mockCostsApi = vi.hoisted(() => ({ quotaPacing: vi.fn() }));
const mockInstanceSettingsApi = vi.hoisted(() => ({
  getGeneral: vi.fn(),
  updateGeneral: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));

vi.mock("@/api/costs", () => ({ costsApi: mockCostsApi }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/api/access", () => ({ accessApi: mockAccessApi }));

// The Radix select does not open under jsdom; a native select keeps the
// same value/onValueChange contract.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) =>
    createElement(
      "select",
      {
        "aria-label": "Pacing mode",
        value,
        disabled,
        onChange: (event: { target: { value: string } }) => onValueChange(event.target.value),
      },
      children,
    ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => createElement("optgroup", { label: "Modes" }, children),
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) =>
    createElement("option", { value }, children),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: QuotaPacingSettings = {
  enabled: true,
  mode: "auto",
  sessionReservePercent: 20,
  weeklyAllowancePercent: 8,
  pollIntervalSec: 300,
};

const STATE: QuotaPacingState = {
  enabled: true,
  settings: SETTINGS,
  lastPolledAt: "2026-09-30T12:00:00.000Z",
  nextPollAt: "2026-09-30T12:05:00.000Z",
  lastError: null,
  providers: [
    {
      provider: "anthropic",
      mode: "low",
      reason: "session_ahead",
      session: {
        usedPercent: 60,
        targetPercent: 40,
        aheadPercent: 20,
        elapsedPercent: 50,
        resetsAt: "2026-09-30T14:30:00.000Z",
        windowSeconds: 18_000,
      },
      weekly: {
        usedPercent: 40,
        targetPercent: 58,
        aheadPercent: -18,
        elapsedPercent: 50,
        resetsAt: "2026-10-04T00:00:00.000Z",
        windowSeconds: 604_800,
      },
      lastPolledAt: "2026-09-30T12:00:00.000Z",
      lastError: null,
    },
    {
      provider: "openai",
      mode: "full",
      reason: "no_data",
      session: null,
      weekly: null,
      lastPolledAt: null,
      lastError: "no local codex auth token",
    },
  ],
};

function generalSettings(quotaPacing: QuotaPacingSettings) {
  return {
    censorUsernameInLogs: false,
    feedbackDataSharingPreference: "prompt",
    backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    quotaPacing,
  };
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("QuotaPacingPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockInstanceSettingsApi.getGeneral.mockResolvedValue(generalSettings(SETTINGS));
    mockInstanceSettingsApi.updateGeneral.mockResolvedValue(generalSettings(SETTINGS));
    mockCostsApi.quotaPacing.mockResolvedValue(STATE);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "local-board",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
      source: "local_implicit",
      keyId: null,
      user: null,
    });
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    root = null;
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPanel() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <QuotaPacingPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("Low pace"));
  }

  function input(labelText: string) {
    const label = Array.from(container.querySelectorAll("label")).find((entry) => entry.textContent === labelText);
    const element = label ? container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`) : null;
    if (!element) throw new Error(`No input labelled ${labelText}`);
    return element;
  }

  function saveButton() {
    const button = Array.from(container.querySelectorAll("button")).find(
      (entry) => entry.textContent?.trim() === "Save pacing",
    );
    if (!button) throw new Error("No save button");
    return button;
  }

  it("shows the mode, usage against pace, and poll errors per provider", async () => {
    await renderPanel();

    expect(mockCostsApi.quotaPacing).toHaveBeenCalledWith("company-1");
    const anthropic = container.querySelector('[data-testid="quota-pacing-anthropic"]');
    expect(anthropic?.textContent).toContain("Anthropic");
    expect(anthropic?.textContent).toContain("Low pace");
    expect(anthropic?.textContent).toContain("Session usage is ahead of pace.");
    expect(anthropic?.textContent).toContain("60% used");
    expect(anthropic?.textContent).toContain("Pace target 40%");
    expect(anthropic?.textContent).toContain("Resets");
    const markers = Array.from(anthropic?.querySelectorAll<HTMLElement>('[data-testid="pace-marker"]') ?? []);
    expect(markers.map((marker) => marker.style.left)).toEqual(["40%", "58%"]);
    const bar = anthropic?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-label")).toBe("Session window: 60% used, pace target 40%");

    const openai = container.querySelector('[data-testid="quota-pacing-openai"]');
    expect(openai?.textContent).toContain("Full pace");
    expect(openai?.textContent).toContain("No quota data. Agents use their configured limit.");
    expect(openai?.textContent).toContain("Last poll failed: no local codex auth token");
  });

  it("saves the mode, session reserve, and weekly allowance", async () => {
    await renderPanel();
    await vi.waitFor(() => expect(input("Session reserve (%)").disabled).toBe(false));
    expect(saveButton().disabled).toBe(true);

    flushSync(() => setSelectValue(container.querySelector<HTMLSelectElement>('select[aria-label="Pacing mode"]')!, "half"));
    flushSync(() => setInputValue(input("Session reserve (%)"), "30"));
    flushSync(() => setInputValue(input("Weekly allowance (%)"), "5"));
    expect(saveButton().disabled).toBe(false);
    flushSync(() => saveButton().click());

    await vi.waitFor(() => expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledOnce());
    expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledWith({
      quotaPacing: { mode: "half", sessionReservePercent: 30, weeklyAllowancePercent: 5 },
    });
    // The panel refreshes the pacing state after a save.
    await vi.waitFor(() => expect(mockCostsApi.quotaPacing).toHaveBeenCalledTimes(2));
  });

  it("turns pacing off from the toggle", async () => {
    await renderPanel();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Toggle run pacing"]')!;
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    flushSync(() => toggle.click());

    await vi.waitFor(() =>
      expect(mockInstanceSettingsApi.updateGeneral).toHaveBeenCalledWith({ quotaPacing: { enabled: false } }),
    );
  });

  it("blocks a save with an out-of-range percentage", async () => {
    await renderPanel();
    await vi.waitFor(() => expect(input("Session reserve (%)").disabled).toBe(false));

    flushSync(() => setInputValue(input("Session reserve (%)"), "70"));

    expect(saveButton().disabled).toBe(true);
    expect(container.textContent).toContain("Enter whole percentages within the ranges above.");
  });

  it("shows a failed save inline", async () => {
    mockInstanceSettingsApi.updateGeneral.mockRejectedValue(new Error("Instance admin access required"));
    await renderPanel();
    await vi.waitFor(() => expect(input("Weekly allowance (%)").disabled).toBe(false));

    flushSync(() => setInputValue(input("Weekly allowance (%)"), "10"));
    flushSync(() => saveButton().click());

    await vi.waitFor(() => expect(container.textContent).toContain("Instance admin access required"));
  });

  it("locks the controls for board users who are not instance admins", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      userId: "user-1",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      source: "session",
      keyId: null,
      user: null,
    });
    await renderPanel();

    await vi.waitFor(() => expect(container.textContent).toContain("Only instance admins can change run pacing."));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Toggle run pacing"]')?.disabled).toBe(true);
    expect(input("Session reserve (%)").disabled).toBe(true);
  });

  it("explains that agents keep their limits while pacing is off", async () => {
    const off = { ...SETTINGS, enabled: false };
    mockInstanceSettingsApi.getGeneral.mockResolvedValue(generalSettings(off));
    mockCostsApi.quotaPacing.mockResolvedValue({
      ...STATE,
      enabled: false,
      settings: off,
      providers: STATE.providers.map((provider) => ({ ...provider, mode: "full", reason: "disabled" })),
    });
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <QuotaPacingPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Pacing is off. Agents use their configured concurrent-run limit."),
    );
    expect(container.querySelector('[data-testid="quota-pacing-anthropic"]')).toBeNull();
    expect(container.querySelector('[aria-label="Toggle run pacing"]')?.getAttribute("aria-checked")).toBe("false");
  });
});
