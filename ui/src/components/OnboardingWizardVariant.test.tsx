// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizardVariant } from "./OnboardingWizardVariant";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

// The variant wrapper only cares about *which* wizard renders, so both heavy
// wizard components are stubbed out.
vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: () => <div data-testid="wizard-capsule" />,
}));

vi.mock("./OnboardingWizardClassic", () => ({
  OnboardingWizardClassic: () => <div data-testid="wizard-classic" />,
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("OnboardingWizardVariant (PAP-138)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderVariant() {
    root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingWizardVariant />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the classic wizard when the flag is off (default)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableConferenceRoomChat: false });
    await renderVariant();

    expect(container.querySelector('[data-testid="wizard-classic"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="wizard-capsule"]')).toBeNull();
  });

  it("renders the capsule wizard when the flag is on", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableConferenceRoomChat: true });
    await renderVariant();

    expect(container.querySelector('[data-testid="wizard-capsule"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="wizard-classic"]')).toBeNull();
  });

  it("renders the classic wizard when the settings payload omits the flag", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    await renderVariant();

    expect(container.querySelector('[data-testid="wizard-classic"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="wizard-capsule"]')).toBeNull();
  });

  it("renders neither wizard while the flag is still loading (no cross-variant flash)", async () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    await renderVariant();

    expect(container.querySelector('[data-testid="wizard-classic"]')).toBeNull();
    expect(container.querySelector('[data-testid="wizard-capsule"]')).toBeNull();
  });
});
