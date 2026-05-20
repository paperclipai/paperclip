// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";

const viewerRoleMock = vi.fn<() => {
  isOperator: boolean;
  isInstanceAdmin: boolean;
  membershipRole: string | null;
  loading: boolean;
}>();

vi.mock("./useEaosViewerRole", () => ({
  useEaosViewerRole: () => viewerRoleMock(),
}));

// EaosPageHeader (rendered inside the denied + loading panels) reads
// useCompany. Stub a deterministic value so the guard component renders
// without a CompanyProvider in the test tree.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompany: { id: "c-1", name: "Acme", issuePrefix: "ACME", status: "active" },
    selectedCompanyId: "c-1",
    loading: false,
  }),
}));

import { RequireOperator } from "./RequireOperator";

let container: HTMLDivElement | null = null;

beforeEach(() => {
  viewerRoleMock.mockReset();
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderGuard(initialPath = "/eaos/admin") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/eaos/admin"
            element={
              <RequireOperator surfaceLabel="Admin">
                <div data-testid="operator-payload">operator content</div>
              </RequireOperator>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  });
  return root;
}

describe("RequireOperator (LET-513 §4)", () => {
  it("renders the protected payload when the viewer is operator", async () => {
    viewerRoleMock.mockReturnValue({
      isOperator: true,
      isInstanceAdmin: false,
      membershipRole: "operator",
      loading: false,
    });
    await renderGuard();
    await flushReact();
    expect(
      container?.querySelector('[data-testid="operator-payload"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-require-operator-denied"]'),
    ).toBeNull();
  });

  it("hides the protected payload behind an Operator-only notice for customer viewers", async () => {
    viewerRoleMock.mockReturnValue({
      isOperator: false,
      isInstanceAdmin: false,
      membershipRole: "member",
      loading: false,
    });
    await renderGuard();
    await flushReact();
    expect(
      container?.querySelector('[data-testid="operator-payload"]'),
    ).toBeNull();
    const denied = container?.querySelector(
      '[data-testid="eaos-require-operator-denied"]',
    );
    expect(denied).not.toBeNull();
    expect(denied?.textContent).toContain("admin-only");
  });

  it("renders a neutral loading shell while the access query resolves", async () => {
    viewerRoleMock.mockReturnValue({
      isOperator: false,
      isInstanceAdmin: false,
      membershipRole: null,
      loading: true,
    });
    await renderGuard();
    await flushReact();
    expect(
      container?.querySelector('[data-testid="eaos-require-operator-loading"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-require-operator-denied"]'),
    ).toBeNull();
    expect(
      container?.querySelector('[data-testid="operator-payload"]'),
    ).toBeNull();
  });
});
