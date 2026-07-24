// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizardVariant } from "./OnboardingWizardVariant";

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: () => <div data-testid="wizard-capsule" />,
}));

describe("OnboardingWizardVariant (PAP-138)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function renderVariant() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(<OnboardingWizardVariant />);
    });
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

  it("renders the capsule wizard without reading the chat flag", () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({});
    renderVariant();

    expect(container.querySelector('[data-testid="wizard-capsule"]')).not.toBeNull();
    expect(mockAccessApi.getCurrentBoardAccess).not.toHaveBeenCalled();
  });
});
