// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssignmentScore, IssueAssignmentRouting } from "@paperclipai/shared";
const api = vi.hoisted(() => ({ autoAssign: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: api }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({}) } }));
import { ApiError } from "@/api/api-error";
import { IssueAssignmentRoutingRow } from "./IssueAssignmentRouting";

async function settle() {
  for (let i = 0; i < 8; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); }
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  flushSync(() => root.unmount());
  client.clear();
  document.body.innerHTML = "";
});

const builder = "11111111-1111-4111-8111-111111111111";
const reviewer = "22222222-2222-4222-8222-222222222222";
const writer = "33333333-3333-4333-8333-333333333333";
const s = (value: number, source: AssignmentScore["source"], detail: string | null = null): AssignmentScore => ({ value, source, detail });

const decided: IssueAssignmentRouting = {
  mode: "auto", status: "assigned", strategy: "quality", requiredCapabilities: ["sql"], tier: null,
  selectedAgentId: builder, decidedAt: "2026-11-17T00:00:00.000Z",
  fallback: { fromAgentId: writer, reason: "Usage limit until 2026-11-17T05:00:00.000Z", at: "2026-11-17T01:00:00.000Z" },
  candidates: [
    {
      agentId: builder, name: "Builder", eligible: true, excludedReasons: [], total: 0.81, rank: 1,
      scores: {
        quota: s(0.5, "unknown", "Usage is not reported for this account"),
        cost: s(1, "estimated", "Subscription: no per-run charge"),
        load: s(1, "observed", "0/1 runs active"),
        health: s(0.9, "observed"),
        quality: s(0.8, "configured"),
      },
    },
    { agentId: reviewer, name: "Reviewer", eligible: false, excludedReasons: ["Missing capability: sql"], scores: null, total: null, rank: null },
    { agentId: writer, name: "Writer", eligible: false, excludedReasons: [], scores: null, total: null, rank: null },
  ],
};

function render(routing: IssueAssignmentRouting | null, canAutoAssign = true) {
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <IssueAssignmentRoutingRow issueId="issue-1" companyId="company-1" routing={routing} canAutoAssign={canAutoAssign} inline />
    </QueryClientProvider>,
  ));
}

function open() {
  container.querySelector<HTMLButtonElement>("button")!.click();
  flushSync(() => {});
}

function submit() {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button[type=submit]")].find((entry) => entry.textContent === "Auto-assign")!;
  button.click();
}

describe("IssueAssignmentRoutingRow", () => {
  it("offers auto-assign with a strategy and required capabilities", async () => {
    api.autoAssign.mockResolvedValue({ assignmentRouting: decided });
    render(null);
    expect(container.textContent).toContain("Auto-assign");
    open();
    const strategy = container.querySelector<HTMLSelectElement>('select[aria-label="Strategy"]')!;
    expect([...strategy.options].map((option) => option.textContent)).toEqual(["Balanced", "Cost", "Quality", "Speed"]);
    strategy.value = "speed";
    strategy.dispatchEvent(new Event("change", { bubbles: true }));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Required capabilities"]')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "SQL, docs");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    submit();
    await settle();
    expect(api.autoAssign).toHaveBeenCalledWith("issue-1", { strategy: "speed", requiredCapabilities: ["sql", "docs"] });
  });

  it("shows the decision with ranks, exclusions, score sources, and fallback", () => {
    render(decided, false);
    expect(container.textContent).toContain("Auto: Builder · Quality");
    open();
    const details = container.querySelector("[data-testid=assignment-routing-details]")!.textContent!;
    expect(details).toContain("Assigned");
    expect(details).toContain("Chosen");
    expect(details).toContain("#1 · 0.81");
    expect(details).toContain("Excluded: Missing capability: sql");
    expect(details).toContain("Excluded: Not eligible");
    expect(details).toContain("unknown (neutral 0.50) · Usage is not reported for this account");
    expect(details).toContain("1.00 · estimated");
    expect(details).toContain("0.80 · configured");
    expect(details).toContain("Moved from Writer: Usage limit until 2026-11-17T05:00:00.000Z");
    expect(container.querySelector('select[aria-label="Strategy"]')).toBeNull();
  });

  it("shows a no-match result and surfaces a failed request", async () => {
    api.autoAssign.mockRejectedValue(new ApiError("Automatic assignment needs a task without an assignee", 409, { error: "x" }));
    render({ ...decided, status: "no_candidate", selectedAgentId: null, fallback: null, candidates: [] });
    expect(container.textContent).toContain("Auto: no match · Quality");
    open();
    expect(container.textContent).toContain("No agent matched");
    expect(container.textContent).toContain("No agents to compare.");
    submit();
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Automatic assignment needs a task without an assignee");
  });
});
