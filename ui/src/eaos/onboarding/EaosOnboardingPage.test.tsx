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

  describe("LET-514 — Slack safe install preview + truthful connection state", () => {
    const SLACK_PREVIEW_PATH =
      "/api/companies/c-1/eaos/onboarding/slack-install-preview";
    const SLACK_CONNECTION_PATH =
      "/api/companies/c-1/eaos/onboarding/slack-connection";

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
      connectionState: "not_connected" as const,
    };

    function makeConnectionResponse(
      state:
        | "not_connected"
        | "pending_approval"
        | "applying"
        | "connected"
        | "partial"
        | "error",
      overrides: Partial<{
        planId: string | null;
        approvalId: string | null;
        lastUpdatedAt: string | null;
        approvalCardPath: string | null;
        approvalCardAgentId: string | null;
      }> = {},
    ) {
      return {
        state,
        planId: overrides.planId ?? null,
        approvalId: overrides.approvalId ?? null,
        lastUpdatedAt: overrides.lastUpdatedAt ?? null,
        approvalCardPath:
          overrides.approvalCardPath ??
          (state === "not_connected"
            ? null
            : "/companies/c-1/agents/agent-xyz/capability-apply"),
        approvalCardAgentId:
          overrides.approvalCardAgentId ??
          (state === "not_connected" ? null : "agent-xyz"),
        requiredSecretNames: [
          "SLACK_APP_CLIENT_ID",
          "SLACK_APP_CLIENT_SECRET",
          "SLACK_APP_SIGNING_SECRET",
        ],
        liveApplyEnabled: false as const,
      };
    }

    function stubFetch(handlers: {
      preview?: unknown;
      connection: unknown;
    }) {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (url.endsWith(SLACK_CONNECTION_PATH)) {
          return new Response(JSON.stringify(handlers.connection), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.endsWith(SLACK_PREVIEW_PATH)) {
          return new Response(
            JSON.stringify(handlers.preview ?? SLACK_PREVIEW_RESPONSE),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

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

    it("renders the 'Not connected' badge on initial paint (no fake connected copy)", async () => {
      stubFetch({ connection: makeConnectionResponse("not_connected") });
      try {
        await renderOnboardingPostCreate();
        await waitForAssertion(() => {
          const card = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack"]',
          );
          expect(card?.getAttribute("data-eaos-onboarding-slack-state")).toBe(
            "not_connected",
          );
          const badge = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack-badge-not-connected"]',
          );
          expect(badge?.textContent ?? "").toContain("Not connected");
          // The connected badge MUST NOT be present.
          expect(
            container?.querySelector(
              '[data-testid="eaos-onboarding-next-step-slack-badge-connected"]',
            ),
          ).toBeNull();
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not flip to 'Connected' when only the preview fetch succeeds", async () => {
      // Andrii directive: preview is part of the safe flow, not the whole
      // product. The "Connected" pill must only appear when the server-derived
      // connection state is `connected` — never from a preview fetch.
      stubFetch({
        connection: makeConnectionResponse("not_connected"),
        preview: SLACK_PREVIEW_RESPONSE,
      });
      try {
        await renderOnboardingPostCreate();
        await clickSlackCta();
        await waitForAssertion(() => {
          // The preview body is now visible.
          expect(
            container?.querySelector(
              '[data-testid="eaos-onboarding-next-step-slack-preview"]',
            ),
          ).not.toBeNull();
          // But the card's connection state is still "not_connected" and the
          // connected badge MUST NOT be on the DOM.
          const card = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack"]',
          );
          expect(card?.getAttribute("data-eaos-onboarding-slack-state")).toBe(
            "not_connected",
          );
          expect(
            container?.querySelector(
              '[data-testid="eaos-onboarding-next-step-slack-badge-connected"]',
            ),
          ).toBeNull();
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it.each([
      {
        state: "pending_approval" as const,
        badgeTestId: "eaos-onboarding-next-step-slack-badge-pending",
        badgeLabel: "Pending approval",
      },
      {
        state: "applying" as const,
        badgeTestId: "eaos-onboarding-next-step-slack-badge-applying",
        badgeLabel: "Applying",
      },
      {
        state: "connected" as const,
        badgeTestId: "eaos-onboarding-next-step-slack-badge-connected",
        badgeLabel: "Connected",
      },
      {
        state: "partial" as const,
        badgeTestId: "eaos-onboarding-next-step-slack-badge-partial",
        badgeLabel: "Partially applied",
      },
      {
        state: "error" as const,
        badgeTestId: "eaos-onboarding-next-step-slack-badge-error",
        badgeLabel: "Setup error",
      },
    ])(
      "renders the truthful badge '$badgeLabel' for state '$state'",
      async ({ state, badgeTestId, badgeLabel }) => {
        stubFetch({
          connection: makeConnectionResponse(state, {
            planId: "plan-123",
            lastUpdatedAt: "2026-05-20T10:00:00.000Z",
          }),
        });
        try {
          await renderOnboardingPostCreate();
          await waitForAssertion(() => {
            const card = container?.querySelector(
              '[data-testid="eaos-onboarding-next-step-slack"]',
            );
            expect(card?.getAttribute("data-eaos-onboarding-slack-state")).toBe(
              state,
            );
            const badge = container?.querySelector(`[data-testid="${badgeTestId}"]`);
            expect(badge).not.toBeNull();
            expect(badge?.textContent ?? "").toContain(badgeLabel);
          });
        } finally {
          vi.unstubAllGlobals();
        }
      },
    );

    it("renders the approval card link from the connection response (round-trip)", async () => {
      stubFetch({
        connection: makeConnectionResponse("pending_approval", {
          planId: "plan-pending",
          approvalId: "approval-1",
          approvalCardPath: "/companies/c-1/agents/agent-xyz/capability-apply",
          approvalCardAgentId: "agent-xyz",
        }),
      });
      try {
        await renderOnboardingPostCreate();
        await waitForAssertion(() => {
          const link = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack-approval-link"]',
          ) as HTMLAnchorElement | null;
          expect(link).not.toBeNull();
          expect(link?.getAttribute("href")).toBe(
            "/companies/c-1/agents/agent-xyz/capability-apply",
          );
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
          summary:
            "Preview only — installs the verified Slack capability. Authorization: Bearer xoxb-deadbeef-deadbeef-1234567890 must not survive into the DOM.",
          displayName: "Slack (xoxb-deadbeef-deadbeef-1234567890)",
        },
      };
      stubFetch({
        connection: makeConnectionResponse("not_connected"),
        preview: tainted,
      });
      try {
        await renderOnboardingPostCreate();
        await clickSlackCta();
        await waitForAssertion(() => {
          const previewCard = container?.querySelector(
            '[data-testid="eaos-onboarding-next-step-slack-preview"]',
          );
          expect(previewCard).not.toBeNull();
          const text = previewCard?.textContent ?? "";
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
