// @vitest-environment jsdom
// LET-504 — Render-level coverage for the manual agent builder. Verifies
// the stepper navigates correctly, the sticky summary updates from typed
// values, and unavailable integrations carry truthful labels.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const agentsHireMock = vi.fn();

vi.mock("@/api/agents", () => ({
  agentsApi: {
    hire: (companyId: string, payload: Record<string, unknown>) => agentsHireMock(companyId, payload),
  },
}));

const skillsListMock = vi.fn();

vi.mock("@/api/companySkills", () => ({
  companySkillsApi: {
    list: (companyId: string) => skillsListMock(companyId),
  },
}));

import { AgentBuilderPage } from "./AgentBuilderPage";

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  agentsHireMock.mockReset();
  skillsListMock.mockReset();
  skillsListMock.mockResolvedValue([]);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
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

async function renderBuilder(initialPath = "/eaos/agents/new") {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/eaos/agents/new" element={<AgentBuilderPage />} />
            <Route path="/eaos/agents" element={<div data-testid="roster-stub" />} />
            <Route path="/agents/:agentId" element={<div data-testid="kernel-detail-stub" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

function click(testId: string) {
  const node = container?.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  if (!node) throw new Error(`testId ${testId} not in DOM`);
  node.click();
}

function typeInto(testId: string, value: string) {
  const node = container?.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!node) throw new Error(`testId ${testId} not in DOM`);
  const setter = Object.getOwnPropertyDescriptor(node.constructor.prototype, "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
  node.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("AgentBuilderPage stepper navigation", () => {
  it("starts on Identity and advances forward to Knowledge with the Next CTA", async () => {
    await renderBuilder();
    await waitForAssertion(() => {
      const root = container?.querySelector('[data-testid="eaos-agent-builder-page"]');
      expect(root?.getAttribute("data-step")).toBe("identity");
    });

    // Identity requires Name before Next is enabled — type one before
    // walking the stepper, otherwise the inline validation would block
    // the very first transition (which is the intended behavior).
    await act(async () => typeInto("eaos-agent-builder-name", "Stepper Test Agent"));

    const expectedOrder = ["model", "invocations", "tools", "skills", "knowledge"];
    for (const next of expectedOrder) {
      await act(async () => click("eaos-agent-builder-next"));
      await waitForAssertion(() => {
        const root = container?.querySelector('[data-testid="eaos-agent-builder-page"]');
        expect(root?.getAttribute("data-step")).toBe(next);
      });
    }
  });

  it("disables Next on Identity until Name is filled and surfaces the reason", async () => {
    await renderBuilder();
    await waitForAssertion(() => {
      const root = container?.querySelector('[data-testid="eaos-agent-builder-page"]');
      expect(root?.getAttribute("data-step")).toBe("identity");
      const next = container?.querySelector(
        '[data-testid="eaos-agent-builder-next"]',
      ) as HTMLButtonElement | null;
      expect(next?.disabled).toBe(true);
    });

    // Typing a name then clearing it surfaces the inline validation.
    await act(async () => typeInto("eaos-agent-builder-name", "Temp"));
    await act(async () => typeInto("eaos-agent-builder-name", ""));
    await waitForAssertion(() => {
      const err = container?.querySelector(
        '[data-testid="eaos-agent-builder-name-error"]',
      );
      expect(err?.textContent).toContain("Name is required");
      const reason = container?.querySelector(
        '[data-testid="eaos-agent-builder-disabled-reason"]',
      );
      expect(reason?.textContent).toContain("Name is required");
    });

    // Typing a valid name re-enables Next and clears the disabled reason.
    await act(async () => typeInto("eaos-agent-builder-name", "Research Analyst"));
    await waitForAssertion(() => {
      const next = container?.querySelector(
        '[data-testid="eaos-agent-builder-next"]',
      ) as HTMLButtonElement | null;
      expect(next?.disabled).toBe(false);
      expect(
        container?.querySelector('[data-testid="eaos-agent-builder-name-error"]'),
      ).toBeNull();
    });
  });

  it("shows the Create agent disabled reason on the final step until name is set", async () => {
    await renderBuilder();
    await act(async () => click("eaos-agent-builder-step-knowledge"));
    await waitForAssertion(() => {
      const cta = container?.querySelector(
        '[data-testid="eaos-agent-builder-create"]',
      ) as HTMLButtonElement | null;
      expect(cta?.disabled).toBe(true);
      const reason = container?.querySelector(
        '[data-testid="eaos-agent-builder-disabled-reason"]',
      );
      expect(reason?.textContent).toContain("Identity");
    });
  });

  it("renders Create agent only on the final step", async () => {
    await renderBuilder();
    await waitForAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agent-builder-create"]')).toBeNull();
      expect(container?.querySelector('[data-testid="eaos-agent-builder-next"]')).not.toBeNull();
    });
    // Jump straight to Knowledge via the stepper buttons.
    await act(async () => click("eaos-agent-builder-step-knowledge"));
    await waitForAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-agent-builder-next"]')).toBeNull();
      expect(container?.querySelector('[data-testid="eaos-agent-builder-create"]')).not.toBeNull();
    });
  });
});

describe("AgentBuilderPage summary updates", () => {
  it("reflects typed name and toggled invocation count", async () => {
    await renderBuilder();
    await waitForAssertion(() => {
      const name = container?.querySelector('[data-testid="eaos-agent-builder-summary-name"]');
      expect(name?.textContent).toContain("Unnamed agent");
      const invocations = container?.querySelector(
        '[data-testid="eaos-agent-builder-summary-invocations"]',
      );
      expect(invocations?.textContent).toContain("1 invocation");
    });

    await act(async () => typeInto("eaos-agent-builder-name", "Research Analyst"));
    await waitForAssertion(() => {
      const name = container?.querySelector('[data-testid="eaos-agent-builder-summary-name"]');
      expect(name?.textContent).toContain("Research Analyst");
    });

    await act(async () => click("eaos-agent-builder-step-invocations"));
    await act(async () => click("eaos-agent-builder-scheduled-toggle"));
    await waitForAssertion(() => {
      const invocations = container?.querySelector(
        '[data-testid="eaos-agent-builder-summary-invocations"]',
      );
      expect(invocations?.textContent).toContain("2 invocations");
    });
  });
});

describe("AgentBuilderPage truthful unavailable labels", () => {
  it("labels Slack as Connect, Email as Coming soon, and Webhook as After create", async () => {
    await renderBuilder();
    await act(async () => click("eaos-agent-builder-step-invocations"));
    await waitForAssertion(() => {
      const slack = container?.querySelector('[data-testid="eaos-agent-builder-invocation-slack"]');
      const email = container?.querySelector('[data-testid="eaos-agent-builder-invocation-email"]');
      const webhook = container?.querySelector('[data-testid="eaos-agent-builder-invocation-webhook"]');
      expect(slack?.getAttribute("data-availability")).toBe("connect");
      expect(email?.getAttribute("data-availability")).toBe("backend-gap");
      expect(webhook?.getAttribute("data-availability")).toBe("save-first");
      // Live integration count must stay 0 — fake-success forbidden. The summary
      // labels this as "None connected" rather than implementation jargon.
      const integrations = container?.querySelector(
        '[data-testid="eaos-agent-builder-summary-integrations"]',
      );
      expect(integrations?.textContent?.toLowerCase()).toContain("none connected");
      expect(integrations?.textContent?.toLowerCase()).not.toContain("backend gap");
    });
  });

  it("disables Team learning and Custom knowledge modes until backend lands", async () => {
    await renderBuilder();
    await act(async () => click("eaos-agent-builder-step-knowledge"));
    await waitForAssertion(() => {
      const team = container?.querySelector(
        '[data-testid="eaos-agent-builder-knowledge-mode-team"]',
      ) as HTMLButtonElement | null;
      const custom = container?.querySelector(
        '[data-testid="eaos-agent-builder-knowledge-mode-custom"]',
      ) as HTMLButtonElement | null;
      const personal = container?.querySelector(
        '[data-testid="eaos-agent-builder-knowledge-mode-personal"]',
      ) as HTMLButtonElement | null;
      expect(team?.disabled).toBe(true);
      expect(custom?.disabled).toBe(true);
      expect(personal?.disabled).toBe(false);
    });
  });
});

describe("AgentBuilderPage Create agent CTA", () => {
  it("requires name and model before enabling Create agent", async () => {
    await renderBuilder();
    // Jump straight to Knowledge — name not entered yet.
    await act(async () => click("eaos-agent-builder-step-knowledge"));
    await waitForAssertion(() => {
      const create = container?.querySelector(
        '[data-testid="eaos-agent-builder-create"]',
      ) as HTMLButtonElement | null;
      expect(create?.disabled).toBe(true);
    });

    // Go back to Identity, enter a name, then return.
    await act(async () => click("eaos-agent-builder-step-identity"));
    await act(async () => typeInto("eaos-agent-builder-name", "Builder Test"));
    await act(async () => click("eaos-agent-builder-step-knowledge"));
    await waitForAssertion(() => {
      const create = container?.querySelector(
        '[data-testid="eaos-agent-builder-create"]',
      ) as HTMLButtonElement | null;
      expect(create?.disabled).toBe(false);
    });
  });

  it("calls agentsApi.hire with the configured payload", async () => {
    agentsHireMock.mockResolvedValue({
      agent: { id: "agent-99", urlKey: "builder-test", companyId: "company-1" },
      approval: null,
    });
    await renderBuilder();
    await act(async () => typeInto("eaos-agent-builder-name", "Builder Test"));
    await act(async () => click("eaos-agent-builder-step-knowledge"));
    await act(async () => click("eaos-agent-builder-create"));
    await waitForAssertion(() => {
      expect(agentsHireMock).toHaveBeenCalledTimes(1);
    });
    const [companyId, payload] = agentsHireMock.mock.calls[0]!;
    expect(companyId).toBe("company-1");
    expect(payload).toMatchObject({
      name: "Builder Test",
      adapterType: "claude_local",
      role: "general",
    });
  });
});
