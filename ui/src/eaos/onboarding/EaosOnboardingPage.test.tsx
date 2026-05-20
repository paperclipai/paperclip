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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const createCompanyMock = vi.fn<(input: { name: string }) => Promise<unknown>>();
const navigateMock = vi.fn<(to: string) => void>();
const companiesRef: { current: { id: string; name: string }[] } = { current: [] };

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: companiesRef.current,
    selectedCompany: companiesRef.current[0] ?? null,
    selectedCompanyId: companiesRef.current[0]?.id ?? null,
    loading: false,
    createCompany: (data: { name: string }) => createCompanyMock(data),
  }),
}));

vi.mock("@/lib/router", async () => {
  const RouterDom: typeof import("react-router-dom") = await vi.importActual(
    "react-router-dom",
  );
  return {
    ...RouterDom,
    Link: RouterDom.Link,
    NavLink: RouterDom.NavLink,
    useNavigate: () => (to: string) => navigateMock(to),
  };
});

import { EaosOnboardingPage } from "./EaosOnboardingPage";

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  createCompanyMock.mockReset();
  navigateMock.mockReset();
  companiesRef.current = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

// React tracks input value via a monkey-patched setter; mutating `.value`
// directly bypasses the tracker and `onChange` never fires. The native
// setter pattern is the canonical fix used elsewhere in this repo (see
// `CommandPalette.test.tsx`).
function setReactInputValue(input: HTMLInputElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  nativeSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitForAssertion(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function renderOnboarding() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/onboarding"]}>
          <Routes>
            <Route path="/eaos/onboarding" element={<EaosOnboardingPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("EaosOnboardingPage (LET-513 §1)", () => {
  it("renders the create-workspace form when the user has no companies", async () => {
    companiesRef.current = [];
    await renderOnboarding();
    await waitForAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-page"]'),
      ).not.toBeNull();
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-create-form"]'),
      ).not.toBeNull();
      expect(
        container
          ?.querySelector('[data-testid="eaos-onboarding-page"]')
          ?.getAttribute("data-eaos-onboarding-stage"),
      ).toBe("create-company");
    });
  });

  it("derives the assistant name preview from the company name", async () => {
    companiesRef.current = [];
    await renderOnboarding();
    const input = container?.querySelector(
      '[data-testid="eaos-onboarding-company-name-input"]',
    ) as HTMLInputElement | null;
    await act(async () => {
      if (input) {
        setReactInputValue(input, "Acme");
      }
    });
    await waitForAssertion(() => {
      const preview = container?.querySelector(
        '[data-testid="eaos-onboarding-assistant-name-preview"]',
      );
      expect(preview?.textContent).toContain("Acme");
    });
  });

  it("falls back to Personal Assistant when the company name is long/multi-word", async () => {
    companiesRef.current = [];
    await renderOnboarding();
    const input = container?.querySelector(
      '[data-testid="eaos-onboarding-company-name-input"]',
    ) as HTMLInputElement | null;
    await act(async () => {
      if (input) {
        setReactInputValue(input, "Acme  Heavy   Industries Co Inc");
      }
    });
    await waitForAssertion(() => {
      const preview = container?.querySelector(
        '[data-testid="eaos-onboarding-assistant-name-preview"]',
      );
      expect(preview?.textContent).toContain("Personal Assistant");
    });
  });

  it("calls createCompany on submit and renders the next-steps panel", async () => {
    companiesRef.current = [];
    createCompanyMock.mockImplementation(async ({ name }) => {
      companiesRef.current = [{ id: "c-1", name }];
      return { id: "c-1", name };
    });
    await renderOnboarding();
    const input = container?.querySelector(
      '[data-testid="eaos-onboarding-company-name-input"]',
    ) as HTMLInputElement | null;
    await act(async () => {
      if (input) {
        setReactInputValue(input, "Acme");
      }
    });
    const submit = container?.querySelector(
      '[data-testid="eaos-onboarding-submit"]',
    ) as HTMLButtonElement | null;
    await act(async () => {
      submit?.click();
    });
    await waitForAssertion(() => {
      expect(createCompanyMock).toHaveBeenCalledWith({ name: "Acme" });
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-success"]'),
      ).not.toBeNull();
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-next-steps"]'),
      ).not.toBeNull();
      // LET-515: the MCP catalog CTA is now an interactive "Browse catalog"
      // button. Slack + CEO recommendations remain disabled placeholders.
      const slackCta = container?.querySelector(
        '[data-testid="eaos-onboarding-next-step-slack-cta"]',
      ) as HTMLButtonElement | null;
      expect(slackCta?.disabled).toBe(true);
      const mcpCta = container?.querySelector(
        '[data-testid="eaos-onboarding-next-step-mcp-cta"]',
      ) as HTMLButtonElement | null;
      expect(mcpCta).not.toBeNull();
      expect(mcpCta?.disabled).toBe(false);
      expect(mcpCta?.textContent ?? "").toContain("Browse catalog");
      const ceoCta = container?.querySelector(
        '[data-testid="eaos-onboarding-next-step-ceo-cta"]',
      ) as HTMLButtonElement | null;
      expect(ceoCta?.disabled).toBe(true);
      // Backend-gap label is visible.
      expect(
        container?.querySelector('[data-testid="eaos-onboarding-backend-gap"]'),
      ).not.toBeNull();
    });
  });

  it("does not expose any input or button capable of accepting a raw secret", async () => {
    companiesRef.current = [];
    await renderOnboarding();
    await waitForAssertion(() => {
      const inputs = Array.from(
        container?.querySelectorAll("input") ?? [],
      ) as HTMLInputElement[];
      // The two inputs are the company + assistant names. Neither is a
      // password / API key field.
      const passwordInputs = inputs.filter((input) => input.type === "password");
      expect(passwordInputs.length).toBe(0);
      const allInputNames = inputs.map((input) => input.name + " " + input.id).join(" ");
      expect(allInputNames.toLowerCase()).not.toContain("token");
      expect(allInputNames.toLowerCase()).not.toContain("secret");
      expect(allInputNames.toLowerCase()).not.toContain("apikey");
    });
  });
});
