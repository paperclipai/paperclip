// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getVisibility: vi.fn(),
  updateVisibility: vi.fn(),
}));
const pushToastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceSettingsApi }));
vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

import { CompanySurfaceVisibilityCard } from "./CompanySurfaceVisibilityCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("CompanySurfaceVisibilityCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderCard() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanySurfaceVisibilityCard />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return root;
  }

  it("renders a checkbox per company surface reflecting the policy", async () => {
    mockInstanceSettingsApi.getVisibility.mockResolvedValue({
      companySurfaces: ["company.general", "company.members"],
    });
    const root = await renderCard();

    expect(container.textContent).toContain("Company settings visibility");
    const checkboxes = container.querySelectorAll('[role="checkbox"]');
    expect(checkboxes.length).toBe(5);
    expect(checkboxes[0]?.getAttribute("aria-checked")).toBe("true"); // General
    expect(checkboxes[1]?.getAttribute("aria-checked")).toBe("true"); // Members
    expect(checkboxes[2]?.getAttribute("aria-checked")).toBe("false"); // Invites

    await act(async () => root.unmount());
  });

  it("saves the selected surfaces via PATCH and refreshes capabilities", async () => {
    mockInstanceSettingsApi.getVisibility.mockResolvedValue({
      companySurfaces: [
        "company.general",
        "company.members",
        "company.invites",
        "company.secrets",
        "company.plugins",
      ],
    });
    mockInstanceSettingsApi.updateVisibility.mockResolvedValue({
      companySurfaces: ["company.general"],
    });
    const root = await renderCard();

    const checkboxes = Array.from(container.querySelectorAll('[role="checkbox"]'));
    for (const checkbox of checkboxes.slice(1)) {
      await act(async () => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    }
    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save visibility"),
    );
    expect(saveButton).toBeDefined();
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(mockInstanceSettingsApi.updateVisibility).toHaveBeenCalledWith({
      companySurfaces: ["company.general"],
    });
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Company settings visibility updated" }),
    );

    await act(async () => root.unmount());
  });
});
