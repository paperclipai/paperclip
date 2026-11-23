// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { metricFixture, RESPONSIBILITY_FIXTURE_NOW } from "../../../storybook/fixtures/responsibilities";
import {
  barProposalWithMetricsFixture,
  METRIC_SET_FIXTURES,
  statusReportFixture,
} from "../../../storybook/fixtures/responsibility-metrics";
import { BarProposalCard } from "./BarProposalCard";
import { ResponsibilityMetricSetView, STARTER_METRICS_LABEL } from "./ResponsibilityMetricSet";
import { ResponsibilityStatusBlock } from "./ResponsibilityStatusLead";

const api = vi.hoisted(() => ({ statusReport: vi.fn(), requestStatusUpdate: vi.fn(), metrics: vi.fn(), removeMetric: vi.fn() }));
vi.mock("@/api/responsibility-metrics", () => ({ responsibilityMetricsApi: api }));
vi.mock("@/api/responsibilities", () => ({ responsibilitiesApi: api }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: vi.fn(async () => ({ id: "agent-cto", name: "Chief of staff" })) } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const agentsById = new Map<string, Agent>([["agent-codex", { id: "agent-codex", name: "CodexCoder" } as Agent]]);
const primary = metricFixture({ current: 9, attainment: 0.45, updatedAt: new Date("2026-11-12T08:00:00Z") });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

const tiles = () => [...container.querySelectorAll<HTMLElement>("[data-metric-key]")];
const tile = (title: string) => tiles().find((node) => node.querySelector("h3")?.textContent === title)!;

describe("ResponsibilityMetricSetView", () => {
  it("draws each metric in its form, the bar's own first, with a text alternative and a table", async () => {
    await render(<ResponsibilityMetricSetView set={METRIC_SET_FIXTURES.chosen} now={RESPONSIBILITY_FIXTURE_NOW} primary={primary} agentsById={agentsById} />);
    expect(tiles().map((node) => [node.dataset.metricRole, node.dataset.metricDisplay])).toEqual([
      ["primary", "line"],
      ["supporting", "bar"],
      ["supporting", "percent"],
    ]);
    expect(container.querySelector("[data-metric-set-label]")?.textContent).toBe("Chosen with CodexCoder");

    const line = tile("Investors contacted");
    expect(line.querySelector("[data-metric-value]")?.textContent).toBe("9of 20");
    expect(line.querySelector("[data-series-line]")?.getAttribute("d")).toMatch(/^M/);
    expect(line.querySelector("[data-target-line]")).not.toBeNull();
    expect(line.querySelector("[data-reference-line]")?.textContent).toBe("Target 20");
    expect(line.querySelector('[role="img"]')?.getAttribute("aria-label")).toMatch(/^Line over time of Investors contacted: 8 readings from/);
    expect(line.querySelectorAll("table tbody tr")).toHaveLength(8);
    expect(line.querySelector("[data-metric-read]")?.textContent).toBe("Read yesterday");

    const bars = tile("Intro meetings booked per week");
    expect(bars.querySelectorAll("[data-bar]")).toHaveLength(8);
    expect(bars.querySelectorAll("[data-bar][data-zero]")).toHaveLength(1);
    expect(bars.querySelector("[data-metric-value]")?.textContent).toBe("5target 3");

    const share = tile("Investor emails answered within a day");
    expect(share.querySelector("[data-metric-ring] [data-ring-fill]")).not.toBeNull();
    expect(share.querySelector("[data-metric-ring] [data-ring-target]")).not.toBeNull();
    expect(share.querySelector("[data-metric-value]")?.textContent).toBe("82%target 90%");
  });

  it("says plainly when the metrics are starters, and where their numbers come from", async () => {
    await render(<ResponsibilityMetricSetView set={METRIC_SET_FIXTURES.starter} now={RESPONSIBILITY_FIXTURE_NOW} primary={primary} agentsById={agentsById} />);
    expect(container.querySelector("[data-metric-set-label]")?.textContent).toBe(STARTER_METRICS_LABEL);
    expect(tile("Tasks finished per week").querySelector("[data-metric-read]")?.textContent).toBe("Counted from the work, week by week");
    expect(tile("Open tasks").querySelector("[data-metric-value]")?.textContent).toBe("4· 1 blocked");
    expect(container.querySelectorAll("button[aria-label^='Remove']")).toHaveLength(0);
  });

  it("handles no readings, one reading and a stale one", async () => {
    await render(
      <>
        <ResponsibilityMetricSetView set={METRIC_SET_FIXTURES.empty} now={RESPONSIBILITY_FIXTURE_NOW} agentsById={agentsById} />
        <ResponsibilityMetricSetView set={METRIC_SET_FIXTURES.stale} now={RESPONSIBILITY_FIXTURE_NOW} agentsById={agentsById} />
      </>,
    );
    const empty = tile("Follow-ups sent within two days");
    expect(empty.textContent).toContain("No readings yet");
    expect(empty.querySelector("[data-series-line]")).toBeNull();
    expect(tile("Data room complete").querySelector("[data-ring-fill]")).toBeNull();
    expect(tile("Data room complete").querySelector("[data-metric-value]")?.textContent).toContain("No reading yet");
    const stale = tiles().find((node) => node.dataset.metricKey === "metric-meetings-stale")!;
    expect(stale.textContent).toContain("Not updated in 20 days");

    await render(<ResponsibilityMetricSetView set={METRIC_SET_FIXTURES.sparse} now={RESPONSIBILITY_FIXTURE_NOW} agentsById={agentsById} />);
    const one = tiles().find((node) => node.dataset.metricKey === "metric-one-line")!;
    expect(one.querySelector("[data-latest-point]")).not.toBeNull();
    expect(one.querySelector("[data-series-line]")).toBeNull();
  });

  it("explains how a metric is measured on demand, and lets the owner remove a chosen one", async () => {
    const onRemove = vi.fn();
    await render(
      <ResponsibilityMetricSetView set={METRIC_SET_FIXTURES.chosen} now={RESPONSIBILITY_FIXTURE_NOW} agentsById={agentsById} canRemove onRemove={onRemove} />,
    );
    const bars = tile("Intro meetings booked per week");
    expect(bars.querySelector("[data-metric-description]")).toBeNull();
    const explain = bars.querySelector<HTMLButtonElement>('button[aria-label="How “Intro meetings booked per week” is measured"]')!;
    await act(async () => explain.click());
    expect(explain.getAttribute("aria-expanded")).toBe("true");
    expect(bars.querySelector("[data-metric-description]")?.textContent).toContain("from the shared calendar");
    // The bar's own metric is not removable here.
    expect(tile("Investors contacted").querySelector("button[aria-label^='Remove']")).toBeNull();
    await act(async () => bars.querySelector<HTMLButtonElement>("button[aria-label^='Remove']")!.click());
    expect(onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "metric-meetings" }));
  });
});

describe("ResponsibilityStatusBlock", () => {
  const responsibility = {
    id: "resp-fundraising",
    ownerUserId: "user-storybook",
    status: "active",
    rollup: { health: "behind" as const, healthOverridden: false, statusSentence: "9 of 20 investors contacted, 45% of target" },
  };

  it("leads with the agent's written status, keeps the number's status beneath, and asks for an update", async () => {
    api.statusReport.mockResolvedValue(statusReportFixture({ outOfDate: true }));
    api.requestStatusUpdate.mockResolvedValue(statusReportFixture({ outOfDate: true }, { updateRequested: true }));
    await render(<ResponsibilityStatusBlock responsibility={responsibility} agentsById={agentsById} now={RESPONSIBILITY_FIXTURE_NOW} editable />);
    const lead = container.querySelector<HTMLElement>("[data-agent-status]")!;
    expect(lead.textContent).toContain("At risk");
    expect(lead.querySelector("[data-agent-status-message]")?.textContent).toContain("replies are slipping");
    expect(lead.textContent).toContain("Written by CodexCoder · 2 days ago");
    expect(lead.textContent).toContain("Out of date");
    const derived = container.querySelector<HTMLElement>("[data-derived-status]")!;
    expect(derived.textContent).toBe("From the numberBehind9 of 20 investors contacted, 45% of target");
    expect(lead.compareDocumentPosition(derived) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);

    const ask = lead.querySelector<HTMLButtonElement>("[data-ask-for-update]")!;
    expect(ask.textContent).toBe("Ask CodexCoder for an update");
    await act(async () => ask.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(api.requestStatusUpdate).toHaveBeenCalledWith("resp-fundraising");
    expect(lead.querySelector("[data-ask-for-update]")?.textContent).toBe("Asked CodexCoder for an update");
  });

  it("looks as before without a written status, or when it cannot be read", async () => {
    api.statusReport.mockResolvedValue({ current: null, reporterAgentId: "agent-codex", updateRequested: false, history: [] });
    await render(<ResponsibilityStatusBlock responsibility={responsibility} agentsById={agentsById} now={RESPONSIBILITY_FIXTURE_NOW} editable />);
    expect(container.querySelector("[data-agent-status]")).toBeNull();
    expect(container.querySelector("[data-status-sentence]")?.textContent).toBe("9 of 20 investors contacted, 45% of target");
    expect(container.querySelector("[data-ask-for-update]")).toBeNull();

    api.statusReport.mockRejectedValue(new Error("Not found"));
    await render(<ResponsibilityStatusBlock responsibility={{ ...responsibility, id: "resp-other" }} agentsById={agentsById} now={RESPONSIBILITY_FIXTURE_NOW} editable />);
    expect(container.querySelector("[data-agent-status]")).toBeNull();
    expect(container.textContent).toContain("Behind");
  });
});

describe("BarProposalCard with a metric set", () => {
  it("shows the set as it will appear", async () => {
    await render(<BarProposalCard interaction={barProposalWithMetricsFixture()} />);
    const set = container.querySelector<HTMLElement>("[data-proposed-metrics]")!;
    expect(set.querySelector("h4")?.textContent).toBe("3 metrics on the page");
    expect(tiles().map((node) => [node.querySelector("h3")?.textContent, node.dataset.metricDisplay])).toEqual([
      ["Prospective LPs contacted in the last 14 days", "line"],
      ["Intro calls booked per week", "bar"],
      ["LP emails answered within a day", "percent"],
    ]);
    expect(tile("Intro calls booked per week").querySelectorAll("[data-bar]")).toHaveLength(5);
    expect(tile("Intro calls booked per week").textContent).toContain("Bars per week");
    expect(set.textContent).toContain("Starting readings: Counted from the last five weeks of the shared calendar.");
  });
});
