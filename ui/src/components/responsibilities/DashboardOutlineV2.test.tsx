// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areaFixture,
  areaFundraising,
  areaLegal,
  areaPortfolio,
  fundraisingBehind,
  lpUpdatesStale,
  portfolioOnTrack,
  responsibilityFixture,
  responsibilityOverviewFixture,
} from "../../../storybook/fixtures/responsibilities";
import { DashboardOutlineV2 } from "./DashboardOutlineV2";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "PAP" } }),
}));

vi.mock("./DashboardEditModule", () => ({
  DashboardEditModule: () => null,
}));

function makeAgent(id: string, name: string): Agent {
  return { id, name } as Agent;
}

describe("DashboardOutlineV2", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  function renderOutline(props: Partial<Parameters<typeof DashboardOutlineV2>[0]> = {}) {
    const multiRoutine = responsibilityFixture({
      id: "resp-multi",
      areaId: areaPortfolio.id,
      title: "Ops coverage",
      standard: "Five agents keep ops routines running.",
      rollup: {
        routines: 5,
        routineAgentIds: ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"],
      },
    });
    const unassignedRoutine = responsibilityFixture({
      id: "resp-unassigned-routine",
      areaId: areaPortfolio.id,
      title: "Unassigned routine",
      standard: "A routine with no agent assigned.",
      rollup: {
        routines: 1,
        routineAgentIds: [],
      },
    });
    const overview = props.overview ?? responsibilityOverviewFixture(
      [fundraisingBehind, lpUpdatesStale, portfolioOnTrack, multiRoutine, unassignedRoutine],
      [],
      { areas: [areaFundraising, areaPortfolio, areaLegal] },
    );
    const agents = [
      makeAgent("agent-codex", "CodexCoder"),
      makeAgent("agent-cto", "CTO"),
      makeAgent("agent-1", "Alpha"),
      makeAgent("agent-2", "Beta"),
      makeAgent("agent-3", "Gamma"),
      makeAgent("agent-4", "Delta"),
      makeAgent("agent-5", "Epsilon"),
    ];
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    act(() => {
      root.render(
        <MemoryRouter>
          <DashboardOutlineV2
            companyId="company-1"
            overview={overview}
            agents={agents}
            agentsById={agentsById}
            now={new Date("2026-11-13T12:00:00Z")}
            includeLetGo={false}
            onToggleLetGo={vi.fn()}
            keepEmptyAreas={new Set()}
            onAddResponsibility={vi.fn()}
            onNewTask={vi.fn()}
            onAddArea={vi.fn()}
            onReviewProposals={vi.fn()}
            areaActions={{
              onAddHere: vi.fn(),
              onRename: vi.fn(),
              onArchive: vi.fn(),
              onRestore: vi.fn(),
            }}
            {...props}
          />
        </MemoryRouter>,
      );
    });
  }

  it("renders overlapping routine agent avatars on rows with assigned routines and omits them otherwise", () => {
    renderOutline();

    const fundraisingRow = container.querySelector('[data-responsibility-id="resp-fundraising"]');
    const fundraisingAvatars = fundraisingRow?.querySelector("[data-routine-agents]");
    expect(fundraisingAvatars?.getAttribute("data-routine-agents")).toBe("agent-codex");
    expect(fundraisingAvatars?.getAttribute("role")).toBe("img");
    expect(fundraisingAvatars?.getAttribute("aria-label")).toBe("Routine agents: CodexCoder");
    expect(fundraisingAvatars?.getAttribute("aria-hidden")).toBeNull();
    expect(fundraisingAvatars?.querySelectorAll('[data-slot="agent-avatar"]')).toHaveLength(1);
    expect(fundraisingRow?.querySelector("a")?.textContent).toBe(fundraisingBehind.standard);

    const lpRow = container.querySelector('[data-responsibility-id="resp-lp-updates"]');
    expect(lpRow?.querySelector("[data-routine-agents]")).toBeNull();

    const unassignedRow = container.querySelector('[data-responsibility-id="resp-unassigned-routine"]');
    expect(unassignedRow?.querySelector("[data-routine-agents]")).toBeNull();

    const multiRow = container.querySelector('[data-responsibility-id="resp-multi"]');
    const multiAvatars = multiRow?.querySelector("[data-routine-agents]");
    expect(multiAvatars?.getAttribute("aria-label")).toBe("Routine agents: Alpha, Beta, Gamma, Delta, Epsilon");
    expect(multiAvatars?.getAttribute("title")).toBe("Alpha, Beta, Gamma, Delta, Epsilon");
    expect(multiAvatars?.querySelectorAll('[data-slot="agent-avatar"]')).toHaveLength(4);
    expect(multiAvatars?.textContent).toContain("+1");
  });

  it("bounds render and agent-lookup work linearly on a 500+ responsibility dashboard across both filters", () => {
    const areaCount = 50;
    const perArea = 11;
    const total = areaCount * perArea;
    const agentCount = 520;
    const areas = Array.from({ length: areaCount }, (_, index) =>
      areaFixture({ id: `large-area-${index}`, title: `Large area ${index}`, sortOrder: index }),
    );
    const agents = Array.from({ length: agentCount }, (_, index) =>
      makeAgent(`large-agent-${index}`, `Agent ${index}`),
    );
    const backingAgentsById = new Map(agents.map((agent) => [agent.id, agent]));
    let agentLookups = 0;
    const countedAgentsById = new Proxy(backingAgentsById, {
      get(target, property, receiver) {
        if (property === "get") {
          return (key: string) => {
            if (++agentLookups > total * 12) {
              throw new Error("Routine avatar rendering exceeded linear agent lookup bound");
            }
            return target.get(key);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    let rowReads = 0;
    const responsibilities = Array.from({ length: total }, (_, index) => {
      const hasRoutine = index % 2 === 0;
      const item = responsibilityFixture({
        id: `large-resp-${index}`,
        areaId: `large-area-${Math.floor(index / perArea)}`,
        title: `Large responsibility ${index}`,
        standard: `Standard ${index}`,
        rollup: {
          routines: hasRoutine ? 2 : 0,
          routineAgentIds: hasRoutine ? [`large-agent-${index % agentCount}`, `large-agent-${(index + 1) % agentCount}`] : [],
        },
      });
      return new Proxy(item, {
        get(target, property, receiver) {
          if (++rowReads > total * 40) {
            throw new Error("DashboardOutlineV2 exceeded linear responsibility read bound");
          }
          return Reflect.get(target, property, receiver);
        },
      });
    });
    const overview = responsibilityOverviewFixture(responsibilities, [], { areas });
    const expectedWithRoutines = Math.ceil(total / 2);
    const expectedWithoutRoutines = Math.floor(total / 2);

    renderOutline({ overview, agents, agentsById: countedAgentsById, routineFilter: "has_routines" });
    expect(container.querySelectorAll("li[data-responsibility-id]")).toHaveLength(expectedWithRoutines);
    expect(container.querySelectorAll("[data-routine-agents]")).toHaveLength(expectedWithRoutines);

    renderOutline({ overview, agents, agentsById: countedAgentsById, routineFilter: "no_routines" });
    expect(container.querySelectorAll("li[data-responsibility-id]")).toHaveLength(expectedWithoutRoutines);
    expect(container.querySelectorAll("[data-routine-agents]")).toHaveLength(0);

    expect(agentLookups).toBeGreaterThanOrEqual(expectedWithRoutines * 2);
    expect(agentLookups).toBeLessThanOrEqual(total * 12);
    expect(rowReads).toBeGreaterThanOrEqual(total);
    expect(rowReads).toBeLessThanOrEqual(total * 40);
  });

  it("filters rows by has_routines and no_routines and offers clearing empty results", () => {
    renderOutline({ routineFilter: "has_routines" });
    expect(container.querySelector('[data-responsibility-id="resp-fundraising"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-portfolio"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-lp-updates"]')).toBeNull();
    expect(container.querySelector('[data-outline-v2-area="area-legal"]')).toBeNull();

    renderOutline({ routineFilter: "no_routines" });
    expect(container.querySelector('[data-responsibility-id="resp-lp-updates"]')).not.toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-fundraising"]')).toBeNull();
    expect(container.querySelector('[data-responsibility-id="resp-portfolio"]')).toBeNull();

    const onClearFilter = vi.fn();
    renderOutline({
      overview: responsibilityOverviewFixture([lpUpdatesStale], [], { areas: [areaFundraising] }),
      routineFilter: "has_routines",
      onClearFilter,
    });
    const empty = container.querySelector("[data-outline-v2-no-match]");
    expect(empty?.textContent).toContain("None of your responsibilities have routines yet.");
    const clearButton = empty?.querySelector("button");
    expect(clearButton?.textContent).toBe("Clear filter");
    act(() => clearButton?.click());
    expect(onClearFilter).toHaveBeenCalledTimes(1);
  });
});
