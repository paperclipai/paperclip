// @vitest-environment jsdom
import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { getCachedIssueDetail, seedIssueDetailCache } from "../lib/issueDetailCache";

vi.mock("../lib/issueDetailCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/issueDetailCache")>();
  return { ...actual, getCachedIssueDetail: vi.fn(actual.getCachedIssueDetail) };
});

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & React.ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (identifier: string) => `/cases/${identifier}`,
}));

const issuesApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Controllable IntersectionObserver: nothing is "in view" until the test says
 * so, which is exactly the property the production gate relies on.
 */
let observed: Element[] = [];
let intersect: (targets: Element[]) => void;

class TestIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {
    intersect = (targets) => {
      this.callback(
        targets.map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry),
        this as unknown as IntersectionObserver,
      );
    };
  }
  observe(target: Element) { observed.push(target); }
  unobserve(target: Element) { observed = observed.filter((element) => element !== target); }
  disconnect() { observed = []; }
  takeRecords() { return []; }
}

function issueFixture(identifier: string): Issue {
  return {
    id: `id-${identifier}`,
    companyId: "company-1",
    identifier,
    title: `Title for ${identifier}`,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    projectId: null,
    parentId: null,
    description: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    executionRunId: null,
    issueNumber: 1,
    requestDepth: 0,
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
  } as unknown as Issue;
}

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

function render(markdown: string) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MarkdownBody>{markdown}</MarkdownBody>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
}

function issueAnchors() {
  return Array.from(host.querySelectorAll('a[data-mention-kind="issue"]'));
}

beforeEach(() => {
  observed = [];
  issuesApi.get.mockReset();
  vi.mocked(getCachedIssueDetail).mockClear();
  (window as any).IntersectionObserver = TestIntersectionObserver;
  (globalThis as any).IntersectionObserver = TestIntersectionObserver;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

const LINK_COUNT = 50;
const markdownWithLinks = (count: number) =>
  Array.from({ length: count }, (_, index) => `See [PAP-${index + 1}](/issues/PAP-${index + 1}).`).join("\n\n");

describe("MarkdownIssueLink fetch gating", () => {
  it("issues no requests for links that have never been on screen", () => {
    issuesApi.get.mockImplementation(() => new Promise(() => {}));
    render(markdownWithLinks(LINK_COUNT));

    expect(issueAnchors()).toHaveLength(LINK_COUNT);
    expect(issuesApi.get).not.toHaveBeenCalled();
    expect(observed).toHaveLength(LINK_COUNT);
  });

  it("fetches at most one request per link scrolled into view, four at a time", async () => {
    const resolvers: Array<(issue: Issue) => void> = [];
    issuesApi.get.mockImplementation(
      (ref: string) => new Promise<Issue>((resolve) => resolvers.push(() => resolve(issueFixture(ref)))),
    );
    render(markdownWithLinks(LINK_COUNT));

    const scrolled = observed.slice(0, 10);
    await act(async () => {
      intersect(scrolled);
    });

    // Bounded concurrency: ten links became visible, four requests are open.
    expect(issuesApi.get).toHaveBeenCalledTimes(4);

    while (resolvers.length) {
      const pending = resolvers.splice(0, resolvers.length);
      await act(async () => {
        for (const resolve of pending) resolve(issueFixture("PAP-1"));
      });
    }

    expect(issuesApi.get).toHaveBeenCalledTimes(scrolled.length);
    expect(issuesApi.get.mock.calls.map(([ref]) => ref)).toHaveLength(new Set(issuesApi.get.mock.calls.map(([ref]) => ref)).size);
  });

  it("never fetches a link whose issue is already in the detail cache", async () => {
    issuesApi.get.mockImplementation(() => new Promise(() => {}));
    for (let index = 1; index <= LINK_COUNT; index += 1) {
      seedIssueDetailCache(queryClient, issueFixture(`PAP-${index}`), { issueRef: `PAP-${index}` });
    }

    render(markdownWithLinks(LINK_COUNT));
    await act(async () => {
      intersect([...observed]);
    });

    expect(issuesApi.get).not.toHaveBeenCalled();
    expect(host.innerHTML).toContain("Title for PAP-1");
  });

  it("does not re-scan the detail cache on every parent re-render", async () => {
    issuesApi.get.mockImplementation(() => new Promise(() => {}));
    render(markdownWithLinks(LINK_COUNT));

    // One lookup per link at mount, and none of them found anything.
    const afterMount = vi.mocked(getCachedIssueDetail).mock.calls.length;
    expect(afterMount).toBe(LINK_COUNT);

    // A re-render of the surrounding body (a new comment arriving below the
    // cited ones) must not re-run the miss path for every link on the page.
    render(`${markdownWithLinks(LINK_COUNT)}\n\nA later comment arrives.`);
    expect(issueAnchors()).toHaveLength(LINK_COUNT);
    expect(vi.mocked(getCachedIssueDetail).mock.calls.length).toBe(afterMount);

    // The lookup does re-run for the links that reach the viewport, which is
    // the only moment its answer decides whether a request fires.
    await act(async () => {
      intersect(observed.slice(0, 10));
    });
    expect(vi.mocked(getCachedIssueDetail).mock.calls.length).toBe(afterMount + 10);
  });
});
