// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ONBOARDING_AGENT_STEP,
} from "./lib/onboarding-route";

/**
 * The third way into onboarding for a company that already exists: the "Add
 * Agent" card on `/{prefix}/onboarding`, shown once the wizard is dismissed.
 *
 * The route resolver and the dashboard both choose the step from whether the
 * company already has its mission. This button hardcoded the mission step, so
 * the one entry point whose own copy says "add another agent" was the one that
 * stopped to ask for the mission again.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom's CSS parser rejects the custom-property marker rule stitches inserts
// (`--sxs{--sxs:N}`), pulled into <App>'s eager import graph transitively via
// @codesandbox/sandpack-react. Substitute a benign, valid rule on parse failure
// so stitches' index bookkeeping stays intact and the module graph evaluates.
vi.hoisted(() => {
  const sheetProto = window.CSSStyleSheet.prototype as unknown as {
    insertRule: (rule: string, index?: number) => number;
    __papLauncherPatched?: boolean;
  };
  if (!sheetProto.__papLauncherPatched) {
    const original = sheetProto.insertRule;
    sheetProto.insertRule = function patched(this: CSSStyleSheet, rule: string, index?: number) {
      try {
        return original.call(this, rule, index);
      } catch {
        try {
          return original.call(this, ".pap-launcher-noop{}", index);
        } catch {
          return this.cssRules?.length ?? 0;
        }
      }
    };
    sheetProto.__papLauncherPatched = true;
  }
});

const routeState = vi.hoisted(() => ({ companyPrefix: "PC1" as string | undefined }));
const dialogState = vi.hoisted(() => ({
  onboardingOpen: false,
  onboardingRouteDismissed: true,
  openOnboarding: vi.fn(),
}));
const mockGoalsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ companyPrefix: routeState.companyPrefix }),
    useActiveCompanyPrefix: () => routeState.companyPrefix ?? null,
  };
});

vi.mock("./context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Acme", issuePrefix: "PC1" }],
    selectedCompanyId: "company-1",
    loading: false,
    error: null,
  }),
}));

vi.mock("./context/DialogContext", () => ({
  useDialogActions: () => ({ openOnboarding: dialogState.openOnboarding }),
  useDialogState: () => ({
    onboardingOpen: dialogState.onboardingOpen,
    onboardingRouteDismissed: dialogState.onboardingRouteDismissed,
  }),
}));

vi.mock("./api/goals", () => ({ goalsApi: mockGoalsApi }));

const { OnboardingRoutePage } = await import("./App");

const COMPANY_GOAL = {
  id: "goal-1",
  companyId: "company-1",
  title: "Scale the marketplace",
  description: null,
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-03-02T00:00:00Z"),
  updatedAt: new Date("2026-03-02T00:00:00Z"),
};

describe("the onboarding launcher's Add Agent button", () => {
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let root: Root | null = null;

  async function render() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingRoutePage />
        </QueryClientProvider>,
      );
    });
  }

  async function settle(ticks = 12) {
    for (let i = 0; i < ticks; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function addAgentButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Add Agent"),
    );
    // Asserted rather than optional-chained: a lookup that silently matches
    // nothing turns the click below into a no-op and the test into decoration.
    expect(button).toBeDefined();
    return button!;
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    routeState.companyPrefix = "PC1";
    dialogState.onboardingOpen = false;
    dialogState.onboardingRouteDismissed = true;
    mockGoalsApi.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("opens on the agent step for a company that already has its mission", async () => {
    mockGoalsApi.list.mockResolvedValue([COMPANY_GOAL]);
    await render();
    await settle();

    await act(async () => {
      addAgentButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(dialogState.openOnboarding).toHaveBeenCalledWith({
      initialStep: ONBOARDING_AGENT_STEP,
      companyId: "company-1",
    });
  });

  it("goes to the agent step whatever the goals lookup says", async () => {
    // Two tests lived here — company with no mission, and a lookup that failed —
    // and both sent "Add Agent" to the mission step first. Onboarding no longer
    // asks for the mission, so neither goal state can divert a button whose
    // whole purpose is adding an agent.
    for (const goals of [
      () => mockGoalsApi.list.mockResolvedValue([]),
      () => mockGoalsApi.list.mockRejectedValue(new Error("goals unavailable")),
    ]) {
      dialogState.openOnboarding.mockClear();
      goals();
      await render();
      await settle();

      await act(async () => {
        addAgentButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(dialogState.openOnboarding).toHaveBeenCalledWith({
        initialStep: ONBOARDING_AGENT_STEP,
        companyId: "company-1",
      });
    }
  });

  it("opens with no company when the prefix matches none", async () => {
    routeState.companyPrefix = "NOPE";
    await render();
    await settle();

    const start = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start Onboarding"),
    );
    expect(start).toBeDefined();
    await act(async () => {
      start!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(dialogState.openOnboarding).toHaveBeenCalledWith();
  });
});
