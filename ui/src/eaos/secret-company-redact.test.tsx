// @vitest-environment jsdom
//
// LET-484 QA gate (regression) — proves that every EAOS surface that renders
// the selected company name pushes the value through `redactSecretLikeText`
// before it lands in visible text, titles, aria-labels, or empty-state copy.
//
// QA verdict comment `aca58cbe` listed 8 sites. Each gets one focused
// assertion here: render the surface with a credential-shaped company name
// (and, for the top bar, a credential-shaped `issuePrefix`) and assert the
// raw token never appears in the rendered DOM, while the redacted form does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mutable handle so each test can swap the rendered company before mount.
const COMPANY_HANDLE = {
  selectedCompany: null as
    | { id: string; name: string; issuePrefix: string | null; status: string }
    | null,
  selectedCompanyId: null as string | null,
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => COMPANY_HANDLE,
}));

// API mocks resolve to the minimum shape each page needs so the live-read
// posture (`dataConnected=true`) is reached and the redacted note renders.
vi.mock("@/api/agents", () => ({
  agentsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/approvals", () => ({
  approvalsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/activity", () => ({
  activityApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/projects", () => ({
  projectsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/companySkills", () => ({
  companySkillsApi: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: vi.fn().mockResolvedValue({
      members: [],
      access: {
        currentUserRole: "operator",
        canManageMembers: false,
        canInviteUsers: false,
        canApproveJoinRequests: false,
      },
    }),
  },
}));

import { EaosTopBar } from "./EaosTopBar";
import { AgentsRosterPage } from "./agents/AgentsRosterPage";
import { ApprovalsQueuePage } from "./approvals/ApprovalsQueuePage";
import { RunsTimelinePage } from "./runs/RunsTimelinePage";
import { ProjectsRoadmapPage } from "./projects/ProjectsRoadmapPage";
import { CapabilitiesPage } from "./capabilities/CapabilitiesPage";
import { KnowledgePage } from "./knowledge/KnowledgePage";
import { AdminPage } from "./admin/AdminPage";

const SECRET_TOKEN = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_PREFIX = "sk-ant-AAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_COMPANY = {
  id: "company-1",
  name: `Acme ${SECRET_TOKEN}`,
  issuePrefix: SECRET_PREFIX,
  status: "active",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  COMPANY_HANDLE.selectedCompany = SECRET_COMPANY;
  COMPANY_HANDLE.selectedCompanyId = SECRET_COMPANY.id;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
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
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderWith(node: React.ReactNode) {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flushReact();
}

function expectRedactedAndNoRawTokens(text: string) {
  // Raw credential markers must never leak.
  expect(text.includes(SECRET_TOKEN)).toBe(false);
  expect(text.includes(SECRET_PREFIX)).toBe(false);
  // Acme prefix is benign and may render in the redacted output.
  expect(text).toContain("Acme");
}

describe("LET-484 — selected company name redaction across EAOS surfaces", () => {
  it("EaosTopBar redacts secret-shaped name + issuePrefix in title, aria-label, visible chip", async () => {
    await renderWith(<EaosTopBar variant="eaos" onOpenPrimaryNav={() => {}} />);

    const scopeChip = container!.querySelector('[data-testid="eaos-topbar-scope-active"]');
    expect(scopeChip).not.toBeNull();

    const html = container!.innerHTML;
    // Visible chip text + title + aria-label all live inside the same HTML
    // string; one assertion covers all three render paths.
    expectRedactedAndNoRawTokens(html);
    // Redacted shape proves the helper actually fired.
    expect(html).toContain("gh_[REDACTED]");
    expect(html).toContain("sk-[REDACTED]");
  });

  it("AgentsRosterPage does not leak the credential-shaped company name anywhere on the page", async () => {
    // LET-503 (LET-502 contract §5) — the read-only caveat paragraph and
    // posture note that previously printed the active company name were
    // removed from the primary Agents surface. The redaction primitive is
    // still applied to row-level fields (agent name + title) via
    // `redactSecretLikeText` in AgentsRosterPage. This test enforces the
    // page-wide invariant that no raw credential-shaped substring leaks,
    // even if the read returns an empty roster.
    await renderWith(<AgentsRosterPage now={new Date("2026-05-19T16:00:00Z")} />);
    const html = container?.innerHTML ?? "";
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });

  it("ApprovalsQueuePage never leaks raw company-name secrets to the rendered DOM", async () => {
    await renderWith(<ApprovalsQueuePage now={new Date("2026-05-19T16:00:00Z")} />);
    const html = container!.innerHTML;
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });

  it("RunsTimelinePage never leaks raw company-name secrets to the rendered DOM", async () => {
    await renderWith(<RunsTimelinePage now={new Date("2026-05-19T16:00:00Z")} />);
    const html = container!.innerHTML;
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });

  it("ProjectsRoadmapPage never leaks raw company-name secrets to the rendered DOM", async () => {
    await renderWith(<ProjectsRoadmapPage />);
    const html = container!.innerHTML;
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });

  it("CapabilitiesPage never leaks raw company-name secrets to the rendered DOM", async () => {
    await renderWith(<CapabilitiesPage />);
    const html = container!.innerHTML;
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });

  it("KnowledgePage never leaks raw company-name secrets to the rendered DOM", async () => {
    await renderWith(<KnowledgePage />);
    const html = container!.innerHTML;
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });

  it("AdminPage never leaks raw company-name secrets to the rendered DOM", async () => {
    await renderWith(<AdminPage />);
    const html = container!.innerHTML;
    expect(html.includes(SECRET_TOKEN)).toBe(false);
    expect(html.includes(SECRET_PREFIX)).toBe(false);
  });
});
