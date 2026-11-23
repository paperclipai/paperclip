// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResponsibilityOverview, ResponsibilityWithRollup } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import {
  fundraisingBehind,
  proposedDealFlow,
  proposedLpRelations,
  proposedWithoutBar,
  responsibilityOverviewFixture,
} from "../../../storybook/fixtures/responsibilities";
import { ProposedResponsibilitiesReview, proposalMissing } from "./ProposedResponsibilitiesReview";

const api = vi.hoisted(() => ({ update: vi.fn(), overview: vi.fn() }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: api }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = fundraisingBehind.companyId;
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (label: string, scope: ParentNode = host) =>
  [...scope.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
const rowFor = (title: string) =>
  [...host.querySelectorAll("li[data-proposal-id]")].find((row) => row.querySelector("h4")?.textContent === title) ?? null;
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(proposed: ResponsibilityWithRollup[] = [proposedDealFlow, proposedLpRelations], onReviewed = vi.fn()) {
  const overview = responsibilityOverviewFixture([fundraisingBehind], proposed);
  client.setQueryData(queryKeys.responsibilities.overview(COMPANY, {}), overview);
  api.overview.mockResolvedValue(overview);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProposedResponsibilitiesReview companyId={COMPANY} onReviewed={onReviewed} />
      </QueryClientProvider>,
    );
  });
  return onReviewed;
}

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  client.clear();
});

describe("ProposedResponsibilitiesReview", () => {
  it("groups proposals by area and shows each one's bar, number and evidence", async () => {
    await render([proposedDealFlow, proposedLpRelations, proposedWithoutBar]);
    const groups = [...host.querySelectorAll("[data-area-group]")];
    expect(groups.map((group) => group.querySelector("h3")?.textContent)).toEqual(["Fundraising", "Deal flow", "No area"]);
    expect(groups[0]!.textContent).toContain("LP relations");

    const sourcing = rowFor("Sourcing")!;
    expect(sourcing.textContent).toContain("Every promising founder gets a first meeting within two weeks.");
    expect(sourcing.textContent).toContain("First meetings booked: no reading yet, target 12");
    expect(sourcing.textContent).toContain("first meetings with founders");
    expect(rowFor("LP relations")!.textContent).toContain("Reply time: 3 days, target at most 2 days");
    // With no metric at all it can be confirmed as it is: its bar is set later.
    expect(rowFor("Brand")!.textContent).not.toContain("Needs");
    // Confirm all covers only the proposals that can be confirmed as they are.
    expect(button("Confirm all 3")).toBeDefined();
  });

  it("confirms one proposal optimistically and reports it", async () => {
    let resolve: (value: unknown) => void = () => {};
    api.update.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onReviewed = await render();

    await act(async () => button("Confirm", rowFor("Sourcing")!)!.click());
    // Gone at once, and moved into the cached overview as active.
    expect(rowFor("Sourcing")).toBeNull();
    const cached = client.getQueryData<ResponsibilityOverview>(queryKeys.responsibilities.overview(COMPANY, {}));
    expect(cached?.proposed.map((item) => item.id)).toEqual([proposedLpRelations.id]);
    expect(cached?.responsibilities.find((item) => item.id === proposedDealFlow.id)?.status).toBe("active");
    expect(api.update).toHaveBeenCalledExactlyOnceWith(proposedDealFlow.id, { status: "active" });

    const confirmed = { ...proposedDealFlow, status: "active" as const };
    await act(async () => resolve(confirmed));
    await flush();
    expect(onReviewed).toHaveBeenCalledExactlyOnceWith({ confirmed: [confirmed], dismissed: [] });
  });

  it("dismisses a proposal", async () => {
    const dismissed = { ...proposedLpRelations, status: "dismissed" as const };
    api.update.mockResolvedValue(dismissed);
    const onReviewed = await render();

    await act(async () => button("Dismiss", rowFor("LP relations")!)!.click());
    await flush();
    expect(api.update).toHaveBeenCalledExactlyOnceWith(proposedLpRelations.id, { status: "dismissed" });
    expect(rowFor("LP relations")).toBeNull();
    expect(onReviewed).toHaveBeenCalledExactlyOnceWith({ confirmed: [], dismissed: [dismissed] });
  });

  it("adjusts the name, bar, metric, direction and target, then confirms", async () => {
    api.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...proposedDealFlow, id, ...patch }));
    await render();

    await act(async () => button("Adjust", rowFor("Sourcing")!)!.click());
    const form = host.querySelector('form[aria-label="Adjust Sourcing"]')!;
    const [title, metricName, target, unit] = form.querySelectorAll("input");
    const standard = form.querySelector("textarea")!;
    const direction = form.querySelector<HTMLSelectElement>('select[aria-label="Better when it is"]')!;
    await act(async () => {
      setInputValue(title!, "Deal sourcing");
      setInputValue(standard, "Every good founder gets a first meeting within ten days.");
      setInputValue(metricName!, "First meetings");
      setInputValue(target!, "15");
      setInputValue(unit!, "  ");
      direction.value = "at_most";
      direction.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Save and confirm", form)!.click());
    await flush();
    expect(api.update).toHaveBeenCalledExactlyOnceWith(proposedDealFlow.id, {
      title: "Deal sourcing",
      standard: "Every good founder gets a first meeting within ten days.",
      metricKind: "volume",
      metricName: "First meetings",
      metricTarget: 15,
      metricDirection: "at_most",
      metricUnit: null,
      metricLow: null,
      metricHigh: null,
      status: "active",
    });
  });

  it("will not save an adjustment with a required field blank", async () => {
    await render();
    await act(async () => button("Adjust", rowFor("Sourcing")!)!.click());
    const form = host.querySelector('form[aria-label="Adjust Sourcing"]')!;
    await act(async () => setInputValue(form.querySelector("textarea")!, "  "));
    await act(async () => button("Save and confirm", form)!.click());
    expect(api.update).not.toHaveBeenCalled();
    expect(form.textContent).toContain("Describe the bar");
  });

  it("confirms a proposal with no bar as it is", async () => {
    api.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...proposedWithoutBar, id, ...patch }));
    await render([proposedWithoutBar]);
    await act(async () => button("Confirm", rowFor("Brand")!)!.click());
    await flush();
    expect(api.update).toHaveBeenCalledExactlyOnceWith(proposedWithoutBar.id, { status: "active" });
  });

  it("asks for the rest of a half-filled bar instead of confirming it", async () => {
    const half = { ...proposedWithoutBar, id: "resp-half", title: "Posts", metricName: "Posts approved" };
    await render([half]);
    expect(rowFor("Posts")!.textContent).toContain("Needs the bar and a target before you can confirm it.");
    await act(async () => button("Confirm", rowFor("Posts")!)!.click());
    expect(api.update).not.toHaveBeenCalled();
    const form = host.querySelector('form[aria-label="Adjust Posts"]')!;
    expect(form.textContent).toContain("Describe the bar");
    expect(form.textContent).toContain("Set a target");
  });

  it("adjusts a proposal with no bar, leaving its metric blank", async () => {
    api.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...proposedWithoutBar, id, ...patch }));
    await render([proposedWithoutBar]);
    await act(async () => button("Adjust", rowFor("Brand")!)!.click());
    const form = host.querySelector('form[aria-label="Adjust Brand"]')!;
    expect(form.textContent).toContain("You can leave what you measure blank and set it up later.");
    await act(async () => setInputValue(form.querySelector("input")!, "Brand voice"));
    await act(async () => button("Save and confirm", form)!.click());
    await flush();
    expect(api.update).toHaveBeenCalledExactlyOnceWith(proposedWithoutBar.id, { title: "Brand voice", standard: null, status: "active" });
  });

  it("clears a proposal's metric when the person empties it, keeping the sentence", async () => {
    api.update.mockImplementation(async (id: string, patch: Record<string, unknown>) => ({ ...proposedLpRelations, id, ...patch }));
    await render();
    await act(async () => button("Adjust", rowFor("LP relations")!)!.click());
    const form = host.querySelector('form[aria-label="Adjust LP relations"]')!;
    const [, metricName, target, unit] = form.querySelectorAll("input");
    await act(async () => {
      setInputValue(metricName!, "");
      setInputValue(target!, "");
      setInputValue(unit!, "");
    });
    await act(async () => button("Save and confirm", form)!.click());
    await flush();
    expect(api.update).toHaveBeenCalledExactlyOnceWith(proposedLpRelations.id, {
      title: "LP relations",
      standard: proposedLpRelations.standard,
      metricName: null,
      metricUnit: null,
      metricTarget: null,
      metricLow: null,
      metricHigh: null,
      metricCurrent: null,
      status: "active",
    });
  });

  it("opens the form with the server's missing fields when it refuses (422)", async () => {
    api.update.mockRejectedValue(new ApiError("refused", 422, {
      error: "A responsibility needs its bar (standard), a metric name and a target before it can be active",
      details: { missing: ["metricTarget"] },
    }));
    const onReviewed = await render();

    await act(async () => button("Confirm", rowFor("Sourcing")!)!.click());
    await flush();
    const row = rowFor("Sourcing") ?? host.querySelector('li[data-proposal-id="resp-deal-flow"]');
    expect(row?.querySelector('[role="alert"]')?.textContent).toBe("Add a target to confirm it.");
    const form = host.querySelector('form[aria-label="Adjust Sourcing"]')!;
    expect(form.textContent).toContain("Set a target");
    const cached = client.getQueryData<ResponsibilityOverview>(queryKeys.responsibilities.overview(COMPANY, {}));
    expect(cached?.proposed.map((item) => item.id)).toEqual([proposedDealFlow.id, proposedLpRelations.id]);
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it("confirms all remaining complete proposals in one action", async () => {
    api.update.mockImplementation(async (id: string) => ({ ...proposedDealFlow, id, status: "active" }));
    const onReviewed = await render();

    await act(async () => button("Confirm all 2")!.click());
    await flush();
    expect(api.update).toHaveBeenCalledTimes(2);
    expect(api.update).toHaveBeenCalledWith(proposedDealFlow.id, { status: "active" });
    expect(api.update).toHaveBeenCalledWith(proposedLpRelations.id, { status: "active" });
    expect(onReviewed).toHaveBeenCalledOnce();
    expect(onReviewed.mock.calls[0]![0].confirmed).toHaveLength(2);
    expect(host.querySelector("section")).toBeNull();
  });

  it("puts a refused proposal back with the error beside it", async () => {
    api.update.mockRejectedValue(new Error("Only the person who owns this responsibility can change it"));
    const onReviewed = await render();

    await act(async () => button("Confirm", rowFor("Sourcing")!)!.click());
    await flush();
    const row = rowFor("Sourcing");
    expect(row).not.toBeNull();
    expect(row?.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t save your answer for “Sourcing”.");
    expect(onReviewed).not.toHaveBeenCalled();
  });
});

describe("proposalMissing", () => {
  it("names what a proposal still needs", () => {
    expect(proposalMissing(proposedDealFlow)).toEqual([]);
    // No metric at all: nothing; it is confirmed as not measured.
    expect(proposalMissing(proposedWithoutBar)).toEqual([]);
    expect(proposalMissing({ ...proposedWithoutBar, metricName: "Posts approved" })).toEqual(["standard", "metricTarget"]);
    expect(proposalMissing({ ...proposedWithoutBar, standard: "Bar", metricTarget: 4 })).toEqual(["metricName"]);
  });
});
