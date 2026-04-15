// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
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

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [mockCompany],
    selectedCompany: mockCompany,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

const removeMock = vi.fn<(id: string) => Promise<{ ok: true }>>();

vi.mock("../api/companies", () => ({
  companiesApi: {
    update: vi.fn(async () => mockCompany),
    archive: vi.fn(async () => mockCompany),
    remove: (id: string) => removeMock(id),
  },
}));

let healthMockResponse = {
  status: "ok" as const,
  features: { companyDeletionEnabled: true },
};

vi.mock("../api/health", () => ({
  healthApi: {
    get: () => Promise.resolve(healthMockResponse),
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
  healthMockResponse = {
    status: "ok",
    features: { companyDeletionEnabled: true },
  };
});

afterEach(() => {
  root.unmount();
  container.remove();
});

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <CompanySettings />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function waitFor(fn: () => void, timeout = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      fn();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  fn();
}

function findButton(text: string) {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
}

describe("CompanySettings delete button", () => {
  it("renders the Delete company button when companyDeletionEnabled is true", async () => {
    renderSettings();
    await waitFor(() => expect(findButton("Delete company")).toBeTruthy());
  });

  it("does not render the Delete company button when companyDeletionEnabled is false", async () => {
    healthMockResponse = {
      status: "ok",
      features: { companyDeletionEnabled: false },
    };
    renderSettings();
    await waitFor(() => expect(findButton("Archive company")).toBeTruthy());
    expect(findButton("Delete company")).toBeUndefined();
  });

  it("shows confirmation dialog when Delete company is clicked", async () => {
    renderSettings();
    await waitFor(() => expect(findButton("Delete company")).toBeTruthy());

    findButton("Delete company")!.click();

    await waitFor(() => {
      expect(container.textContent).toContain("This cannot be undone");
    });
    expect(findButton("Cancel")).toBeTruthy();
    expect(findButton("Delete")).toBeTruthy();
  });

  it("hides confirmation dialog when Cancel is clicked", async () => {
    renderSettings();
    await waitFor(() => expect(findButton("Delete company")).toBeTruthy());

    findButton("Delete company")!.click();
    await waitFor(() => expect(findButton("Cancel")).toBeTruthy());

    findButton("Cancel")!.click();
    await waitFor(() => {
      expect(container.textContent).not.toContain("This cannot be undone");
    });
  });

  it("calls companiesApi.remove and navigates on confirm", async () => {
    removeMock.mockResolvedValue({ ok: true });
    renderSettings();
    await waitFor(() => expect(findButton("Delete company")).toBeTruthy());

    findButton("Delete company")!.click();
    await waitFor(() => expect(findButton("Delete")).toBeTruthy());

    findButton("Delete")!.click();

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("company-1"));
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/"));
  });
});
