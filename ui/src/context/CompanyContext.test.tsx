// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import {
  CompanyProvider,
  resolveBootstrapCompanySelection,
  shouldClearStoredCompanySelection,
  useCompany,
} from "./CompanyContext";

const mockCompaniesApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  detachInflightList: vi.fn(),
}));

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

const mockAuthApi = vi.hoisted(() => ({
  getSession: vi.fn(),
}));

vi.mock("../api/auth", () => ({
  authApi: mockAuthApi,
}));

function sessionFor(userId: string) {
  return {
    session: { id: `session-${userId}`, userId },
    user: { id: userId, name: "Example", email: `${userId}@example.com`, image: null },
  };
}

const activeCompany = { id: "company-1" };
const secondActiveCompany = { id: "company-2" };
const archivedCompany = { id: "archived-company" };

function makeCompany(id: string): Company {
  return {
    id,
    name: "Paperclip",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix: "PAP",
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: null,
    requireBoardApprovalForNewAgents: false,
    interactionResolverGovernance: {},
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function flushReact() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

let captured: ReturnType<typeof useCompany> | null = null;

function Probe({ onSelectedCompanyId }: { onSelectedCompanyId: (companyId: string | null) => void }) {
  const company = useCompany();
  captured = company;
  const { selectedCompanyId } = company;
  useEffect(() => {
    onSelectedCompanyId(selectedCompanyId);
  }, [onSelectedCompanyId, selectedCompanyId]);
  return <div data-selected-company-id={selectedCompanyId ?? ""} />;
}

describe("resolveBootstrapCompanySelection", () => {
  it("does not expose a stale stored company id before companies load", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [],
      sidebarCompanies: [],
      selectedCompanyId: null,
      storedCompanyId: "stale-company",
    })).toBeNull();
  });

  it("replaces a stale stored company id with the first loaded company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: "stale-company",
    })).toBe("company-1");
  });

  it("keeps a valid selected company ahead of stored bootstrap state", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: "company-1",
      storedCompanyId: "stale-company",
    })).toBe("company-1");
  });

  it("keeps a valid stored company id instead of falling back to the first company", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany, secondActiveCompany],
      sidebarCompanies: [activeCompany, secondActiveCompany],
      selectedCompanyId: null,
      storedCompanyId: "company-2",
    })).toBe("company-2");
  });

  it("uses selectable sidebar companies before archived companies", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [archivedCompany, activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: null,
      storedCompanyId: "archived-company",
    })).toBe("company-1");
  });

  it("keeps an explicitly selected archived company that still exists", () => {
    // The Layout route-sync selects the company the URL names, archived
    // included. Vetoing that selection here re-selected an active company,
    // the route-sync selected the archived one again, and the two effects
    // ping-ponged until React threw #185 and unmounted the app.
    expect(resolveBootstrapCompanySelection({
      companies: [archivedCompany, activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: "archived-company",
      storedCompanyId: null,
    })).toBe("archived-company");
  });

  it("still replaces a selected company that no longer exists at all", () => {
    expect(resolveBootstrapCompanySelection({
      companies: [activeCompany],
      sidebarCompanies: [activeCompany],
      selectedCompanyId: "deleted-company",
      storedCompanyId: null,
    })).toBe("company-1");
  });
});

describe("shouldClearStoredCompanySelection", () => {
  it("does not clear the stored company selection during an unauthorized company list response", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: true,
      errored: false,
    })).toBe(false);
  });

  it("clears the stored company selection when an authorized company list is empty", () => {
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: false,
      errored: false,
    })).toBe(true);
  });

  it("does not clear the stored company selection when the request failed", () => {
    // `companiesListQueryOptions` sets `retry: false`, and a failure before any
    // success leaves `data` undefined — which the provider defaults to an empty
    // list. That is indistinguishable from "asked, and owns nothing", so
    // without this a single failed request on a cold load would drop the
    // customer's stored company.
    expect(shouldClearStoredCompanySelection({
      companies: [],
      isLoading: false,
      unauthorized: false,
      errored: true,
    })).toBe(false);
  });
});

describe("CompanyProvider", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    captured = null;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    mockAuthApi.getSession.mockResolvedValue(null);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.clearAllMocks();
  });

  it("keeps the stored company when the company request fails", async () => {
    // The seam the predicate test above cannot reach: the provider defaults a
    // failed request to an empty list, so the effect has to be told the
    // request errored or it reads that as "asked, and owns nothing" and clears
    // the customer's stored company.
    localStorage.setItem("paperclip.selectedCompanyId", "company-a");
    mockCompaniesApi.list.mockRejectedValue(new Error("companies unavailable"));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={() => {}} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe("company-a");
  });

  it("does not expose a stale stored company id before companies load", async () => {
    localStorage.setItem("paperclip.selectedCompanyId", "stale-company");
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });

    expect(seen).toEqual([null]);
  });

  it("replaces a stale stored company id with the first loaded company", async () => {
    localStorage.setItem("paperclip.selectedCompanyId", "stale-company");
    queryClient.setQueryData(queryKeys.companies.all, {
      companies: [makeCompany("company-1")],
      unauthorized: false,
    });
    mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));
    const seen: Array<string | null> = [];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyProvider>
            <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
          </CompanyProvider>
        </QueryClientProvider>,
      );
    });

    expect(seen).toEqual([null, "company-1"]);
    expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe("company-1");
  });

  // The `["companies"]` cache entry is shared app-wide and carries no account
  // identity, so it survives a change of account in this tab. Cached data is
  // served whether or not it is stale, so freshness cannot stand in for
  // "belongs to the account signed in now".
  describe("when the account changes in this tab", () => {
    async function bootWithFirstAccount(seen: Array<string | null>) {
      mockAuthApi.getSession.mockResolvedValue(sessionFor("user-1"));
      queryClient.setQueryData(queryKeys.companies.all, {
        companies: [makeCompany("company-1")],
        unauthorized: false,
      });
      mockCompaniesApi.list.mockImplementation(() => new Promise(() => {}));

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <CompanyProvider>
              <Probe onSelectedCompanyId={(companyId) => seen.push(companyId)} />
            </CompanyProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();

      expect(seen).toEqual([null, "company-1"]);
      expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe("company-1");
    }

    it("drops the previous account's selection and re-reads the list", async () => {
      const seen: Array<string | null> = [];
      await bootWithFirstAccount(seen);

      let resolveSecondList: ((companies: Company[]) => void) | null = null;
      mockCompaniesApi.list.mockImplementation(
        () =>
          new Promise<Company[]>((resolve) => {
            resolveSecondList = resolve;
          }),
      );

      await act(async () => {
        queryClient.setQueryData(queryKeys.auth.session, sessionFor("user-2"));
      });
      await flushReact();

      // Nothing from the previous account is exposed while the new list loads.
      expect(seen).toEqual([null, "company-1", null]);
      expect(queryClient.getQueryData(queryKeys.companies.all)).toBeUndefined();
      expect(resolveSecondList).not.toBeNull();
      // The replacement fetch must not be coalesced into a `/companies` request
      // issued under the previous session.
      expect(mockCompaniesApi.detachInflightList).toHaveBeenCalled();

      await act(async () => {
        resolveSecondList?.([makeCompany("company-2")]);
        await Promise.resolve();
      });
      await flushReact();

      expect(seen).toEqual([null, "company-1", null, "company-2"]);
      expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe("company-2");
    });

    // The replacement fetch is the only thing standing between the account
    // change and a usable app: the cache entry has already been removed, so a
    // failure here leaves the tab with no list and no selection. It must not
    // also leave it with no way out.
    it("recovers the list when the replacement fetch fails and is retried", async () => {
      const seen: Array<string | null> = [];
      await bootWithFirstAccount(seen);

      mockCompaniesApi.list.mockRejectedValue(new Error("network down"));

      await act(async () => {
        queryClient.setQueryData(queryKeys.auth.session, sessionFor("user-2"));
      });
      await flushReact();
      // Past the bounded retries, so the failure has actually settled.
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      });
      await flushReact();

      // The previous account's company is gone and nothing took its place.
      expect(seen).toEqual([null, "company-1", null]);
      // Reported as unavailable, not as an account that owns nothing. Without
      // this the switcher renders "No companies", which is a false claim.
      expect(captured?.companyListUnavailable).toBe(true);
      expect(captured?.companies).toEqual([]);

      // The recovery path actually recovers.
      mockCompaniesApi.list.mockResolvedValue([makeCompany("company-2")]);
      await act(async () => {
        await captured?.retryCompanies();
      });
      await flushReact();

      expect(captured?.companyListUnavailable).toBe(false);
      expect(seen).toEqual([null, "company-1", null, "company-2"]);
      expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe("company-2");
    });

    // A transient blip must not need the customer to notice and click anything.
    // Nothing configures a retry — the second attempt is the observer's own,
    // issued when it rebinds to a fresh query after the removal above. This
    // pins that, so the recovery affordance stays reserved for real outages
    // rather than becoming the only way back from a one-off blip.
    it("rides out a single failed replacement request without help", async () => {
      const seen: Array<string | null> = [];
      await bootWithFirstAccount(seen);

      mockCompaniesApi.list
        .mockRejectedValueOnce(new Error("blip"))
        .mockResolvedValue([makeCompany("company-2")]);

      await act(async () => {
        queryClient.setQueryData(queryKeys.auth.session, sessionFor("user-2"));
      });
      await flushReact();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      });
      await flushReact();

      expect(captured?.companyListUnavailable).toBe(false);
      expect(seen).toEqual([null, "company-1", null, "company-2"]);
    });

    // The failure flag must not outlive the failure. A later success — a focus
    // refetch, an invalidation from anywhere — settles the question, including
    // when the honest answer is an empty list. Otherwise an account that owns
    // nothing reads as "couldn't load", behind a retry that cannot change it.
    it("stops reporting the list as unavailable once any fetch succeeds", async () => {
      const seen: Array<string | null> = [];
      await bootWithFirstAccount(seen);

      mockCompaniesApi.list.mockRejectedValue(new Error("network down"));
      await act(async () => {
        queryClient.setQueryData(queryKeys.auth.session, sessionFor("user-2"));
      });
      await flushReact();
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      });
      await flushReact();

      expect(captured?.companyListUnavailable).toBe(true);

      // This account genuinely owns no companies, and the request says so.
      mockCompaniesApi.list.mockResolvedValue([]);
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: queryKeys.companies.all });
      });
      await flushReact();

      expect(captured?.companies).toEqual([]);
      expect(captured?.companyListUnavailable).toBe(false);
    });

    it("leaves the selection alone when the same account is observed again", async () => {
      const seen: Array<string | null> = [];
      await bootWithFirstAccount(seen);
      const listCallsAfterBoot = mockCompaniesApi.list.mock.calls.length;

      // A session refetch returns an equal-but-new object for the same account.
      await act(async () => {
        queryClient.setQueryData(queryKeys.auth.session, sessionFor("user-1"));
      });
      await flushReact();

      expect(seen).toEqual([null, "company-1"]);
      expect(localStorage.getItem("paperclip.selectedCompanyId")).toBe("company-1");
      expect(mockCompaniesApi.list.mock.calls.length).toBe(listCallsAfterBoot);
    });
  });
});
