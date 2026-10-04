// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserProfileResponse } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { UserProfile } from "./UserProfile";

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

const mockUserProfilesApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockUseParams = vi.hoisted(() => vi.fn());

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

vi.mock("../api/userProfiles", () => ({
  userProfilesApi: mockUserProfilesApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP" },
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useParams: () => mockUseParams(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function windowStats(key: "last7" | "last30" | "all", label: string): UserProfileResponse["stats"][number] {
  return {
    key,
    label,
    touchedIssues: 4,
    createdIssues: 2,
    completedIssues: 3,
    assignedOpenIssues: 1,
    commentCount: 5,
    activityCount: 9,
    costCents: 1200,
    inputTokens: 1000,
    cachedInputTokens: 200,
    outputTokens: 300,
    costEventCount: 2,
  };
}

function profileFor(userId: string): UserProfileResponse {
  return {
    user: {
      id: userId,
      slug: "jane-example",
      name: "Jane Example",
      email: "jane@example.com",
      image: null,
      membershipRole: "owner",
      membershipStatus: "active",
      joinedAt: new Date("2026-01-05T00:00:00Z"),
    },
    stats: [windowStats("last7", "Last 7 days"), windowStats("last30", "Last 30 days"), windowStats("all", "All time")],
    daily: [],
    recentIssues: [],
    recentActivity: [],
    topAgents: [],
    topProviders: [],
  };
}

const EDIT_PROFILE_HREF = "/company/settings/instance/profile";

describe("UserProfile", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockUseParams.mockReturnValue({ userSlug: "jane-example" });
    mockAuthApi.getSession.mockResolvedValue({
      session: { id: "session-1", userId: "user-1" },
      user: {
        id: "user-1",
        name: "Jane Example",
        email: "jane@example.com",
        image: null,
      },
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(profile: UserProfileResponse, hiddenSettings: string[] = []) {
    mockUserProfilesApi.get.mockResolvedValue(profile);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.health, {
      status: "ok",
      deploymentMode: "authenticated",
      hiddenSettings,
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <UserProfile />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  it("offers an edit link on the viewer's own profile", async () => {
    const root = await render(profileFor("user-1"));

    expect(container.textContent).toContain("Jane Example");
    const editLink = container.querySelector<HTMLAnchorElement>(`a[href="${EDIT_PROFILE_HREF}"]`);
    expect(editLink).not.toBeNull();
    expect(editLink?.textContent).toContain("Edit profile");
    expect(editLink?.querySelector("svg")?.classList).toContain("lucide-user-round-pen");

    await act(async () => root.unmount());
  });

  it("keeps other users' profiles read-only", async () => {
    const root = await render(profileFor("user-2"));

    expect(container.textContent).toContain("Jane Example");
    expect(container.querySelector(`a[href="${EDIT_PROFILE_HREF}"]`)).toBeNull();
    expect(container.textContent).not.toContain("Edit profile");

    await act(async () => root.unmount());
  });

  it("drops the edit link when the operator hides profile settings", async () => {
    const root = await render(profileFor("user-1"), ["instance.profile"]);

    expect(container.textContent).toContain("Jane Example");
    expect(container.querySelector(`a[href="${EDIT_PROFILE_HREF}"]`)).toBeNull();

    await act(async () => root.unmount());
  });
});
