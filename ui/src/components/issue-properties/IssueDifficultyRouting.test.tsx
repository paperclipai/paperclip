// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueDifficultyRouting } from "@paperclipai/shared";
const api = vi.hoisted(() => ({ setDifficultyTier: vi.fn(), clearDifficultyTier: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: api }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn().mockResolvedValue({}) } }));
import { ApiError } from "@/api/api-error";
import { IssueDifficultyRoutingRow } from "./IssueDifficultyRouting";

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

const decided: IssueDifficultyRouting = {
  tier: "L2", source: "auto", agentId: null, model: "gpt-5.4", effort: "medium",
  confidence: 0.82, decidedAt: "2026-11-16T00:00:00.000Z", decisionInvocationId: null,
};

function render(routing: IssueDifficultyRouting | null) {
  flushSync(() => root.render(
    <QueryClientProvider client={client}>
      <IssueDifficultyRoutingRow issueId="issue-1" routing={routing} inline />
    </QueryClientProvider>,
  ));
}

function open() {
  const trigger = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Auto"));
  trigger!.click();
  flushSync(() => {});
}

function option(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("[role=option]")].find((button) => button.textContent?.startsWith(label))!;
}

describe("IssueDifficultyRoutingRow", () => {
  it("shows the pending automatic state", () => {
    render(null);
    expect(container.textContent).toContain("Auto (decided at first run)");
  });

  it("shows the decided tier with model, effort, and confidence", () => {
    render(decided);
    expect(container.textContent).toContain("Auto: L2 · gpt-5.4 · medium · 82% confidence");
  });

  it("sets a manual tier and clears it back to automatic", async () => {
    api.setDifficultyTier.mockResolvedValue({ difficultyRouting: { ...decided, tier: "L3", source: "manual" } });
    api.clearDifficultyTier.mockResolvedValue({ difficultyRouting: null });
    render(decided);
    open();
    option("L3").click();
    await settle();
    expect(api.setDifficultyTier).toHaveBeenCalledWith("issue-1", "L3");
    open();
    option("Automatic").click();
    await settle();
    expect(api.clearDifficultyTier).toHaveBeenCalledWith("issue-1");
  });

  it("surfaces a failed change", async () => {
    api.setDifficultyTier.mockRejectedValue(new ApiError("Assignee has no difficulty routing", 422, { error: "x" }));
    render(null);
    open();
    option("L1").click();
    await settle();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Assignee has no difficulty routing");
  });
});
