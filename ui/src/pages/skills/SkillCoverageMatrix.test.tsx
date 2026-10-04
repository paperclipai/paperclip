// @vitest-environment jsdom

import { act as reactAct, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySkillCoverageResponse } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillCoverageMatrix } from "./SkillCoverageMatrix";

const mockCoverage = vi.hoisted(() => vi.fn());
const mockSyncSkills = vi.hoisted(() => vi.fn());

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & ComponentProps<"input">) => (
    <input
      type="checkbox"
      {...props}
      checked={Boolean(checked)}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}));

vi.mock("../../api/companySkills", () => ({
  companySkillsApi: {
    coverage: (...args: unknown[]) => mockCoverage(...args),
  },
}));

vi.mock("../../api/agents", () => ({
  agentsApi: {
    syncSkills: (...args: unknown[]) => mockSyncSkills(...args),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const companyId = "company-1";
const adaId = "11111111-1111-4111-8111-111111111111";
const beaId = "22222222-2222-4222-8222-222222222222";

const coveragePayload: CompanySkillCoverageResponse = {
  skills: [
    { id: "33333333-3333-4333-8333-333333333333", key: "alpha", name: "Alpha", slug: "alpha" },
    { id: "44444444-4444-4444-8444-444444444444", key: "beta", name: "Beta", slug: "beta" },
  ],
  agents: [
    {
      id: adaId,
      name: "Ada",
      urlKey: "ada",
      role: "engineer",
      adapterType: "cursor",
      syncMode: "persistent",
    },
    {
      id: beaId,
      name: "Bea",
      urlKey: "bea",
      role: "pm",
      adapterType: "process",
      syncMode: "unsupported",
    },
  ],
  cells: [
    {
      agentId: adaId,
      skillKey: "alpha",
      desired: true,
      versionId: null,
      actualState: null,
      syncMode: "persistent",
    },
    {
      agentId: adaId,
      skillKey: "beta",
      desired: false,
      versionId: null,
      actualState: null,
      syncMode: "persistent",
    },
    {
      agentId: beaId,
      skillKey: "alpha",
      desired: false,
      versionId: null,
      actualState: null,
      syncMode: "unsupported",
    },
    {
      agentId: beaId,
      skillKey: "beta",
      desired: false,
      versionId: null,
      actualState: null,
      syncMode: "unsupported",
    },
  ],
  summary: {
    agentCount: 2,
    skillCount: 2,
    desiredCellCount: 1,
    gapCount: 3,
    unsupportedAgentCount: 1,
  },
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function act(callback: () => void | Promise<void>) {
  await reactAct(async () => {
    await callback();
  });
}

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function renderMatrix() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <SkillCoverageMatrix companyId={companyId} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => {
    expect(container!.textContent).toContain("Ada");
  });
  return container!;
}

describe("SkillCoverageMatrix", () => {
  it("renders desired, gap, and unsupported cells from the coverage payload", async () => {
    mockCoverage.mockResolvedValue(coveragePayload);
    const node = await renderMatrix();

    expect(node.textContent).toContain("Desired");
    expect(node.querySelector('[aria-label="Attach Beta to Ada"]')?.textContent).toBe("Gap");
    expect(node.textContent).toContain("Unsupported");
    expect(node.textContent).toContain("Gaps");
    expect(node.textContent).toContain("3");
  });

  it("hides desired cells when missing only is checked", async () => {
    mockCoverage.mockResolvedValue(coveragePayload);
    const node = await renderMatrix();
    const toggle = node.querySelector<HTMLInputElement>('input[aria-label="Missing only"]');

    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });

    expect(node.querySelector("table")?.textContent ?? "").not.toContain("Desired");
    expect(node.querySelector('[aria-label="Attach Beta to Ada"]')).not.toBeNull();
  });

  it("attaches a gap through skill sync add", async () => {
    mockCoverage.mockResolvedValue(coveragePayload);
    mockSyncSkills.mockResolvedValue({});
    const node = await renderMatrix();
    const attach = node.querySelector<HTMLButtonElement>('[aria-label="Attach Beta to Ada"]');

    expect(attach).not.toBeNull();
    await act(async () => {
      attach!.click();
    });

    expect(mockSyncSkills).toHaveBeenCalledWith(adaId, ["beta"], "add", companyId);
  });

  it("shows a search-specific empty state when nothing matches", async () => {
    const emptyCoverage: CompanySkillCoverageResponse = {
      skills: [],
      agents: [],
      cells: [],
      summary: {
        agentCount: 0,
        skillCount: 0,
        desiredCellCount: 0,
        gapCount: 0,
        unsupportedAgentCount: 0,
      },
    };
    mockCoverage.mockImplementation(async (_companyId: string, query?: { q?: string }) => (
      query?.q ? emptyCoverage : coveragePayload
    ));
    const node = await renderMatrix();
    const input = node.querySelector<HTMLInputElement>('input[aria-label="Filter agents or skills"]');

    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "zzzz-no-match");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(node.textContent).toContain("No agents or skills match your search.");
    });
    expect(node.textContent).not.toContain("No agents or installed skills to show.");
  });
});
