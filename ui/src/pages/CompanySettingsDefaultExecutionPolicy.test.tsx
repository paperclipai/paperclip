// @vitest-environment jsdom
//
// Regression coverage for three Greptile P2 findings on PR #15267 against
// the default-execution-policy editor in CompanySettings.tsx:
//
//   1. Typing in the policy textarea must not discard unsaved
//      name/description edits (the general-fields sync effect must not
//      depend on defaultExecutionPolicyDirty).
//   2. Typing in the policy textarea after clicking Save, while the save
//      request is still in flight, must not be clobbered by that request's
//      onSuccess handler when it later resolves with the (now-stale)
//      submitted text.
//   3. Typing a newer, unsaved edit while an earlier save is still in
//      flight must not be labeled "Saved" once that earlier save resolves --
//      `mutation.isSuccess` reflects the request settling, not whether the
//      *visible* draft is what got persisted.
//   4. An untouched name/description field must refresh when
//      selectedCompany's own value changes externally (e.g. another tab
//      saved first), instead of reading that refetch as a local edit and
//      offering to write the stale local value back over it.
//
// There is no existing render-test harness for CompanySettings.tsx itself
// (the file named CompanySettings.test.tsx actually renders
// CompanyEnvironments, a different component on the same settings page --
// noted in this PR's own review comments). This file builds a minimal one,
// stubbing out the unrelated heavy subtrees (InstanceGeneralSettings,
// InteractionGovernancePanel, CompanyPatternIcon) so the test stays focused
// on the two state-sync bugs above.

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  putDefaultExecutionPolicy: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

const baseCompany: Company = {
  id: "company-1",
  name: "Paperclip",
  description: "Original description",
  logoUrl: null,
  issuePrefix: "PAP",
  status: "active",
  requireBoardApprovalForNewAgents: false,
  interactionResolverGovernance: {},
  defaultExecutionPolicy: null,
} as unknown as Company;

let selectedCompany: Company = baseCompany;

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/ToastContext", () => ({
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../hooks/useCloudInstance", () => ({
  useCloudInstance: () => null,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [selectedCompany],
    selectedCompany,
    selectedCompanyId: selectedCompany.id,
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (current: unknown) => current,
}));

vi.mock("../components/CompanyPatternIcon", () => ({
  CompanyPatternIcon: () => null,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function getNameInput(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === "Organization name",
  );
  const input = label?.parentElement?.parentElement?.querySelector("input");
  if (!input) throw new Error("Organization name input not found");
  return input as HTMLInputElement;
}

function getDescriptionInput(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === "Description",
  );
  const input = label?.parentElement?.parentElement?.querySelector("input");
  if (!input) throw new Error("Description input not found");
  return input as HTMLInputElement;
}

function getPolicyTextarea(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector(
    "[data-testid='company-settings-default-execution-policy-textarea']",
  );
  if (!textarea) throw new Error("Policy textarea not found");
  return textarea as HTMLTextAreaElement;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CompanySettings default execution policy draft", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;
  let CompanySettings: Awaited<typeof import("./CompanySettings")>["CompanySettings"];

  async function renderApp() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/company/settings"]}>
            <TooltipProvider>
              <CompanySettings />
            </TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(async () => {
    selectedCompany = { ...baseCompany };
    mockCompaniesApi.update.mockReset();
    mockCompaniesApi.putDefaultExecutionPolicy.mockReset();
    mockCompaniesApi.update.mockResolvedValue(selectedCompany);

    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    ({ CompanySettings } = await import("./CompanySettings"));

    root = createRoot(container);
    await renderApp();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("does not discard an unsaved organization name edit when the policy textarea is typed in", async () => {
    const nameInput = getNameInput(container);
    setInputValue(nameInput, "Renamed Co");
    await flushReact();
    expect(nameInput.value).toBe("Renamed Co");

    const policyTextarea = getPolicyTextarea(container);
    setInputValue(policyTextarea, "{");
    await flushReact();

    // The policy keystroke must not have reset the still-unsaved name edit.
    expect(getNameInput(container).value).toBe("Renamed Co");
  });

  it("does not discard an unsaved organization name edit when an unrelated refetch replaces selectedCompany with a new, unchanged-looking object", async () => {
    // Saving the policy draft calls invalidateQueries on queryKeys.companies.all,
    // which refetches the company list and hands CompanyContext a brand new
    // selectedCompany object -- same name/description values, but a new
    // reference -- even though only defaultExecutionPolicy changed. The
    // general-fields sync effect must not treat that reference change alone
    // as a reason to re-copy name/description over an unsaved edit.
    const nameInput = getNameInput(container);
    setInputValue(nameInput, "Renamed Co");
    await flushReact();
    expect(nameInput.value).toBe("Renamed Co");

    selectedCompany = { ...baseCompany };
    await renderApp();

    expect(getNameInput(container).value).toBe("Renamed Co");
  });

  it("does not clobber a newer policy draft with an in-flight save's stale result", async () => {
    let resolveSave: (value: { defaultExecutionPolicy: Company["defaultExecutionPolicy"] }) => void = () => {};
    mockCompaniesApi.putDefaultExecutionPolicy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const policyTextarea = getPolicyTextarea(container);
    setInputValue(policyTextarea, '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    // User keeps typing while the save for '{"stages":[]}' is still in flight.
    setInputValue(getPolicyTextarea(container), '{"stages":[],"maxReviewRounds":2}');
    await flushReact();

    // The in-flight save now resolves with the (now-stale) submitted policy.
    await act(async () => {
      resolveSave({ defaultExecutionPolicy: { stages: [] } as unknown as Company["defaultExecutionPolicy"] });
    });
    await flushReact();
    await flushReact();

    // The newer, unsaved edit must still be in the textarea.
    expect(getPolicyTextarea(container).value).toBe('{"stages":[],"maxReviewRounds":2}');
  });

  it("does not label a newer unsaved edit as Saved once an earlier in-flight save resolves", async () => {
    let resolveSave: (value: { defaultExecutionPolicy: Company["defaultExecutionPolicy"] }) => void = () => {};
    mockCompaniesApi.putDefaultExecutionPolicy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    setInputValue(getPolicyTextarea(container), '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    // User keeps typing while the save for '{"stages":[]}' is still in flight.
    setInputValue(getPolicyTextarea(container), '{"stages":[],"maxReviewRounds":2}');
    await flushReact();

    await act(async () => {
      resolveSave({ defaultExecutionPolicy: { stages: [] } as unknown as Company["defaultExecutionPolicy"] });
    });
    await flushReact();
    await flushReact();

    // The mutation did settle (isSuccess is true), but the visible draft is
    // the newer, still-unsaved edit -- "Saved" must not appear next to it.
    expect(container.textContent).not.toContain("Saved");
    // The save button must still read as actionable, not mid-flight.
    expect(saveButton!.textContent).toBe("Save changes");
  });

  it("still clears the dirty flag after a successful save when the companies-stats cache holds a non-list shape", async () => {
    // queryKeys.companies.all is the prefix ["companies"], which also
    // matches the stats cache entry (shape: CompanyStats, no `companies`
    // array). The post-save cache patch must skip it rather than crash --
    // a crash here would abort onSuccess before the dirty flag clears,
    // leaving a successful save looking permanently unsaved.
    const { queryKeys } = await import("../lib/queryKeys");
    queryClient.setQueryData(queryKeys.companies.stats, { totalCompanies: 1 });

    mockCompaniesApi.putDefaultExecutionPolicy.mockResolvedValue({
      defaultExecutionPolicy: { stages: [] },
    });

    setInputValue(getPolicyTextarea(container), '{"stages":[]}');
    await flushReact();

    const saveButton = container.querySelector(
      "[data-testid='company-settings-default-execution-policy-save']",
    ) as HTMLButtonElement | null;
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();
    await flushReact();

    // The save succeeded and the draft matches it, so the dirty flag must
    // have cleared -- the whole save-button block unmounts once it does.
    expect(
      container.querySelector("[data-testid='company-settings-default-execution-policy-save']"),
    ).toBeNull();
  });

  it("refreshes an untouched organization name instead of treating an external rename as a local edit", async () => {
    // No local edit happened in this tab. Simulate a background refetch
    // (e.g. triggered by the policy save's invalidateQueries, or a plain
    // poll) landing after another tab renamed the company. Before the
    // fix, generalDirty was derived by diffing the still-unchanged local
    // companyName against the new selectedCompany.name, so this refetch
    // alone made it read as dirty: the field kept the old name, a "Save
    // changes" button appeared, and clicking it would have written the old
    // name back over the other tab's rename.
    selectedCompany = { ...baseCompany, name: "Renamed By Other Tab" };
    await renderApp();

    expect(getNameInput(container).value).toBe("Renamed By Other Tab");
    expect(container.textContent).not.toContain("Save changes");
  });

  it("refreshes an untouched organization description the same way", async () => {
    selectedCompany = { ...baseCompany, description: "Set by another tab" };
    await renderApp();

    expect(getDescriptionInput(container).value).toBe("Set by another tab");
    expect(container.textContent).not.toContain("Save changes");
  });

  it("still discards a real unsaved edit on an actual company switch, but preserves it across a same-company refetch", async () => {
    const nameInput = getNameInput(container);
    setInputValue(nameInput, "Mid-edit Name");
    await flushReact();
    expect(getNameInput(container).value).toBe("Mid-edit Name");

    // Switching companies must still discard the outgoing draft, even
    // though it's "dirty" -- this must keep working now that dirty is
    // tracked explicitly instead of derived.
    selectedCompany = { ...baseCompany, id: "company-2", name: "Second Co" };
    await renderApp();

    expect(getNameInput(container).value).toBe("Second Co");
  });
});
