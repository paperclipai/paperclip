// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";
import { CompanySettings } from "./CompanySettings";
import { i18n } from "@/i18n";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

const SELECTED_COMPANY = {
  id: "company-1",
  name: "Acme Robotics",
  description: null,
  status: "active",
  issuePrefix: "ACM",
  brandColor: null,
  logoUrl: null,
  attachmentMaxBytes: null,
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
};

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [SELECTED_COMPANY],
    selectedCompany: SELECTED_COMPANY,
    selectedCompanyId: SELECTED_COMPANY.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// Both panels below the name field own their own queries and are not part of
// what this test covers.
vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_HEALTH = {
  status: "ok" as const,
  cloud: {
    managed: true as const,
    managedBy: "paperclip-cloud" as const,
    stackSlug: "acme-labs",
    cloudBaseUrl: "https://cloud.example.test",
  },
};

const SELF_HOSTED_HEALTH = { status: "ok" as const, cloud: null };

const RENAME_HINT =
  "Renaming can change this company's task ID prefix. Existing task IDs are renumbered and old task links stop resolving.";

describe("CompanySettings rename hint", () => {
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.restoreAllMocks();
    await i18n.changeLanguage("en");
  });

  function render(health: unknown) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // CloudAccessGate owns the health fetch in the app; seeding the cache is how
    // useCloudInstance sees a managed instance under test.
    queryClient.setQueryData(queryKeys.health, health);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    return root;
  }

  function hintText() {
    return Array.from(container.querySelectorAll("p")).find(
      (element) => element.textContent?.trim() === RENAME_HINT,
    );
  }

  it("warns that a rename re-keys task IDs on a managed instance", () => {
    const root = render(CLOUD_HEALTH);
    expect(hintText()).toBeDefined();
    flushSync(() => root.unmount());
  });

  it("stays silent on a self-hosted instance, where a rename keeps the prefix", () => {
    const root = render(SELF_HOSTED_HEALTH);
    expect(hintText()).toBeUndefined();
    flushSync(() => root.unmount());
  });

  it("preserves the full cloud rename warning and an unfinished name across EN/RU switches", async () => {
    const root = render(CLOUD_HEALTH);
    try {
      const name = container.querySelector<HTMLInputElement>('input[type="text"]')!;
      const warning = hintText()!;
      const before = JSON.stringify(SELECTED_COMPANY);
      const draft = "Customer-owned English Name";
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, draft);
        name.dispatchEvent(new Event("input", { bubbles: true }));
      });
      for (const [locale, expected] of [["ru", "При переименовании организации может измениться префикс идентификаторов задач. Существующие задачи получат новые номера, а старые ссылки на них перестанут работать."], ["en", RENAME_HINT]] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect(warning.textContent).toBe(expected);
        expect(container.querySelector('input[type="text"]')).toBe(name);
        expect(name.value).toBe(draft);
        expect(JSON.stringify(SELECTED_COMPANY)).toBe(before);
        expect(mockCompaniesApi.update).not.toHaveBeenCalled();
        expect(mockCompaniesApi.archive).not.toHaveBeenCalled();
        expect(mockAssetsApi.uploadCompanyLogo).not.toHaveBeenCalled();
        expect(mockSetSelectedCompanyId).not.toHaveBeenCalled();
      }
      const save = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save changes")!;
      mockCompaniesApi.update.mockResolvedValue({ ...SELECTED_COMPANY, name: draft });
      await act(async () => save.click());
      expect(mockCompaniesApi.update).toHaveBeenCalledExactlyOnceWith("company-1", { name: draft, description: null });
    } finally { await act(async () => root.unmount()); }
  });

  it("does not acquire a cloud-only renumbering warning when a self-hosted page switches locale", async () => {
    const root = render(SELF_HOSTED_HEALTH);
    try {
      for (const locale of ["en", "ru", "en"] as const) {
        await act(async () => { await i18n.changeLanguage(locale); });
        expect([...container.querySelectorAll("p")].map((p) => p.textContent)).not.toContain(i18n.t("localizationFinalAudit.renameTaskIdsWarning"));
        expect(mockCompaniesApi.update).not.toHaveBeenCalled();
      }
    } finally { await act(async () => root.unmount()); }
  });
});
