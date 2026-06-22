// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { saveMock, getMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  getMock: vi.fn(),
}));

vi.mock("../api/modelPolicies", async () => {
  const actual = await vi.importActual<typeof import("../api/modelPolicies")>("../api/modelPolicies");
  return {
    ...actual,
    modelPoliciesApi: {
      get: getMock,
      save: saveMock,
    },
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Acme" } }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { CompanyModelPolicies } from "./CompanyModelPolicies";

let container: HTMLDivElement;
let root: Root;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <QueryClientProvider client={client}>
      <CompanyModelPolicies />
    </QueryClientProvider>,
  );
}

async function flush() {
  // Let the useQuery promise settle (resolve queryFn -> update cache ->
  // re-render -> run the draft-sync effect -> re-render). React Query schedules
  // its state updates on a macrotask, so a setTimeout tick per act() boundary is
  // needed for the chained query + effect updates to fully commit to the DOM.
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  getMock.mockReset();
  saveMock.mockReset();
  saveMock.mockResolvedValue({ rules: [] });
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CompanyModelPolicies", () => {
  it("renders existing rules from the loaded policy", async () => {
    getMock.mockResolvedValue({
      rules: [{ when: { issuePriority: ["high"] }, modelProfile: "deep", reason: "urgent work" }],
    });
    act(() => renderPage());
    await flush();
    expect(container.textContent).toContain("urgent work");
  });

  it("'Add rule' appends a new rule row", async () => {
    getMock.mockResolvedValue({ rules: [] });
    act(() => renderPage());
    await flush();

    const addButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("add rule"),
    );
    expect(addButton).toBeTruthy();
    await act(async () => {
      addButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // A rule editor now exists — find the Save button enabled by the dirty state.
    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("save"),
    );
    expect(saveButton).toBeTruthy();
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("Save persists the working copy via modelPoliciesApi.save", async () => {
    getMock.mockResolvedValue({ rules: [] });
    act(() => renderPage());
    await flush();

    const addButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("add rule"),
    )!;
    await act(async () => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").toLowerCase().includes("save"),
    )!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(saveMock).toHaveBeenCalledWith("company-1", [{ when: {}, modelProfile: "cheap" }]);
  });
});
