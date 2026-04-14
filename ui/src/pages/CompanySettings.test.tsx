// @vitest-environment jsdom

import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySettings } from "./CompanySettings";

const navigateMock = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: () => navigateMock,
}));

const mockCompany = {
  id: "company-1",
  name: "Test Co",
  description: null,
  brandColor: null,
  logoUrl: null,
  status: "active",
  requireBoardApprovalForNewAgents: false,
  feedbackDataSharingEnabled: false,
  feedbackDataSharingTermsVersion: null,
  feedbackDataSharingConsentAt: null,
  feedbackDataSharingConsentByUserId: null,
};

const setSelectedCompanyIdMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [mockCompany],
    selectedCompany: mockCompany,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: setSelectedCompanyIdMock,
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

const removeMock = vi.fn<(id: string) => Promise<{ ok: true }>>();

vi.mock("../api/companies", () => ({
  companiesApi: {
    update: vi.fn(async () => mockCompany),
    archive: vi.fn(async () => mockCompany),
    remove: (id: string) => removeMock(id),
  },
}));

vi.mock("../api/access", () => ({
  accessApi: {
    createOpenClawInvitePrompt: vi.fn(),
    getInviteOnboarding: vi.fn(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadCompanyLogo: vi.fn() },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  navigateMock.mockClear();
  removeMock.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <CompanySettings />
      </QueryClientProvider>,
    );
  });
}

describe("CompanySettings delete button", () => {
  it("renders the Delete company button in the Danger Zone", () => {
    renderSettings();
    const buttons = Array.from(container.querySelectorAll("button"));
    const deleteBtn = buttons.find((b) => b.textContent?.includes("Delete company"));
    expect(deleteBtn).toBeTruthy();
  });

  it("shows confirmation dialog when Delete company is clicked", () => {
    renderSettings();
    const buttons = Array.from(container.querySelectorAll("button"));
    const deleteBtn = buttons.find((b) => b.textContent?.includes("Delete company"))!;
    act(() => deleteBtn.click());

    const confirmText = container.querySelector(".text-destructive.font-medium");
    expect(confirmText?.textContent).toContain("This cannot be undone");

    const confirmButtons = Array.from(container.querySelectorAll("button"));
    expect(confirmButtons.some((b) => b.textContent === "Cancel")).toBe(true);
    expect(confirmButtons.some((b) => b.textContent === "Delete")).toBe(true);
  });

  it("hides confirmation dialog when Cancel is clicked", () => {
    renderSettings();
    const deleteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete company"),
    )!;
    act(() => deleteBtn.click());

    const cancelBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel",
    )!;
    act(() => cancelBtn.click());

    const confirmText = container.querySelector(".text-destructive.font-medium");
    expect(confirmText).toBeNull();
  });

  it("calls companiesApi.remove and navigates on confirm", async () => {
    removeMock.mockResolvedValue({ ok: true });
    renderSettings();

    const deleteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete company"),
    )!;
    act(() => deleteBtn.click());

    const confirmBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete",
    )!;
    await act(async () => confirmBtn.click());

    expect(removeMock).toHaveBeenCalledWith("company-1");
    expect(navigateMock).toHaveBeenCalledWith("/");
  });
});
