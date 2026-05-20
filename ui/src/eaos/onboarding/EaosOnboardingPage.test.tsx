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
      // LET-514: the Slack CTA is now interactive (safe install preview).
      // MCP picker + CEO recommendations remain disabled placeholders.
      const slackCta = container?.querySelector(
        '[data-testid="eaos-onboarding-next-step-slack-cta"]',
      ) as HTMLButtonElement | null;
      expect(slackCta).not.toBeNull();
      expect(slackCta?.disabled).toBe(false);
      const mcpCta = container?.querySelector(
        '[data-testid="eaos-onboarding-next-step-mcp-cta"]',
      ) as HTMLButtonElement | null;
      expect(mcpCta?.disabled).toBe(true);
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

  describe("LET-514 — Slack safe install preview", () => {
    const SLACK_PREVIEW_PATH =
      "/api/companies/c-1/eaos/onboarding/slack-install-preview";
    const SLACK_PREVIEW_RESPONSE = {
      preview: {
        catalogId: "verified/slack-app",
        displayName: "Slack",
        summary:
          "Preview only — installs the verified Slack capability. No tokens are collected here; the approval card resolves the named secret references from your vault before the install is applied.",
        scopeSummary: ["chat:write", "channels:read", "channels:history", "users:read"],
        requiredSecretNames: [
          "SLACK_APP_CLIENT_ID",
          "SLACK_APP_CLIENT_SECRET",
          "SLACK_APP_SIGNING_SECRET",
        ],
        riskClass: "external-write" as const,
        liveApply: false as const,
        applyPath: "preview_only" as const,
        mcpServerChange: {
          kind: "add" as const,
          serverId: "slack",
          displayName: "Slack",
          catalogId: "verified/slack-app" as const,
          transport: "stdio" as const,
          riskClass: "external-write" as const,
          requiredSecretNames: [
            "SLACK_APP_CLIENT_ID",
            "SLACK_APP_CLIENT_SECRET",
            "SLACK_APP_SIGNING_SECRET",
          ],
          readOnlyHint: false as const,
          destructiveHint: false as const,
          openWorldHint: true as const,
        },
      },
      allowlistedCatalogId: "verified/slack-app" as const,
      approvalCardPath: "/companies/c-1/agents/agent-xyz/capability-apply",
      approvalCardAgentId: "agent-xyz",
      liveApplyEnabled: false as const,
    };

    async function renderOnboardingPostCreate() {
      companiesRef.current = [{ id: "c-1", name: "Acme" }];
      return renderOnboarding();
    }

    async function clickSlackCta() {
      const button = container?.querySelector(
        '[data-testid="eaos-onboarding-next-step-slack-cta"]',
      ) as HTMLButtonElement | null;
      await act(async () => {
        button?.click();
      });
    }

    it("fetches the safe install preview and shows the Slack-connected pill", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith(SLACK_PREVIEW_PATH)) {
          return new Response(JSON.stringify(SLACK_PREVIEW_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await renderOnboardingPostCreate();
        await clickSlackCta();
        await waitForAssertion(() => {
          expect(fetchMock).toHaveBeenCalled();
          const pill = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack-pill"]',
          );
          expect(pill?.textContent ?? "").toContain("Slack connected");
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("renders the approval card link from the preview response (round-trip)", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith(SLACK_PREVIEW_PATH)) {
          return new Response(JSON.stringify(SLACK_PREVIEW_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await renderOnboardingPostCreate();
        await clickSlackCta();
        await waitForAssertion(() => {
          const link = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack-approval-link"]',
          ) as HTMLAnchorElement | null;
          expect(link).not.toBeNull();
          // The approval card link must match the server-issued path verbatim.
          expect(link?.getAttribute("href")).toBe(
            SLACK_PREVIEW_RESPONSE.approvalCardPath,
          );
          // Round-trip: the link points at the canonical capability-apply
          // surface for the bootstrap agent the server resolved for us.
          expect(link?.getAttribute("href")).toMatch(
            /^\/companies\/[^/]+\/agents\/[^/]+\/capability-apply$/,
          );
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("redacts secret-shaped tokens that leak into the preview response copy", async () => {
      const tainted = {
        ...SLACK_PREVIEW_RESPONSE,
        preview: {
          ...SLACK_PREVIEW_RESPONSE.preview,
          // Simulated upstream regression: a Bearer token in the customer-
          // visible summary. The UI must redact it before render.
          summary:
            "Preview only — installs the verified Slack capability. Authorization: Bearer xoxb-deadbeef-deadbeef-1234567890 must not survive into the DOM.",
          displayName: "Slack (xoxb-deadbeef-deadbeef-1234567890)",
        },
      };
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith(SLACK_PREVIEW_PATH)) {
          return new Response(JSON.stringify(tainted), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);

      try {
        await renderOnboardingPostCreate();
        await clickSlackCta();
        await waitForAssertion(() => {
          const previewCard = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack-preview"]',
          );
          expect(previewCard).not.toBeNull();
          const text = previewCard?.textContent ?? "";
          // The raw Bearer-prefixed value and the xoxb- Slack token shape must
          // be redacted before they hit the DOM.
          expect(text).not.toMatch(/Bearer\s+xoxb-/);
          expect(text).not.toMatch(/xoxb-deadbeef/);
          expect(text).toMatch(/\[REDACTED\]/);
        });
      } finally {
        vi.unstubAllGlobals();
      }
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
