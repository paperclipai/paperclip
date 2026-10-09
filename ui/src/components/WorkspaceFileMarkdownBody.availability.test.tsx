// @vitest-environment jsdom

import { StrictMode, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ResolvedWorkspaceResource,
  WorkspaceFileAvailabilityResponse,
  WorkspaceFileAvailabilityResult,
} from "@paperclipai/shared";
import type { FileResourceQuery } from "@/api/file-resources";

const mockAvailability = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/file-resources", () => ({
  fileResourcesApi: { availability: mockAvailability },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/PAP/issues/PAP-1", search: "", hash: "", state: null }),
  useNavigate: () => mockNavigate,
  useCaseHref: () => (identifier: string) => `/cases/${identifier}`,
}));

vi.mock("../context/CompanyContext", () => ({
  useOptionalCompany: () => null,
}));

import { FileViewerProvider } from "@/context/FileViewerContext";
import { ThemeProvider } from "@/context/ThemeContext";
import { WorkspaceFileMarkdownBody } from "./WorkspaceFileMarkdownBody";

const ISSUE_ID = "3fb1a3f4-3f0e-4c58-8d3e-1c2f0f5a9b11";
const PROJECT_ID = "17acae7d-9d0c-46bf-9c82-be9694ac3461";
const WORKSPACE_ID = "0de5f74f-a7d4-4f73-a9a0-455a2b968cf2";

function act(callback: () => void) {
  flushSync(callback);
}

/**
 * Waits on the condition, not on a fixed number of turns. A hand-rolled retry
 * loop is ample on an idle machine and not when the suite runs many workers in
 * parallel: it gives up after N turns and reports a failure on behaviour that
 * works. `vi.waitFor` retries against a time budget, so a loaded worker gets
 * more turns instead.
 *
 * Same replacement as #11499 and #11521, which fixed the shorter-budget
 * instances of this in the routing tests.
 *
 * This was a reimplementation of `vi.waitFor` down to rethrowing the last
 * error, differing only in bounding on turns rather than on time.
 */
async function waitForExpectation(assertion: () => void) {
  await vi.waitFor(assertion);
}

function resource(overrides: Partial<ResolvedWorkspaceResource> = {}): ResolvedWorkspaceResource {
  return {
    kind: "file",
    provider: "git_worktree",
    title: "a.ts",
    displayPath: "ui/src/a.ts",
    workspaceLabel: "Execution workspace",
    workspaceKind: "execution_workspace",
    workspaceId: WORKSPACE_ID,
    previewKind: "text",
    capabilities: { preview: true, download: true, listChildren: false },
    ...overrides,
  };
}

function openable(path: string, overrides: Partial<ResolvedWorkspaceResource> = {}): WorkspaceFileAvailabilityResult {
  return {
    query: { path, workspace: "auto", projectId: null, workspaceId: null },
    openable: true,
    resource: resource({ displayPath: path, ...overrides }),
  };
}

function unavailable(path: string, reason: string): WorkspaceFileAvailabilityResult {
  return {
    query: { path, workspace: "auto", projectId: null, workspaceId: null },
    openable: false,
    unavailableReason: reason,
    resource: null,
  };
}

function respondWith(results: WorkspaceFileAvailabilityResult[]): WorkspaceFileAvailabilityResponse {
  return { kind: "workspace_file_availability", results };
}

/** Echo every requested path back as openable. */
function echoOpenable(_issueId: string, queries: FileResourceQuery[]) {
  return Promise.resolve(respondWith(queries.map((query) => openable(query.path))));
}

let container: HTMLDivElement;
let root: Root;

function render(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <FileViewerProvider issueId={ISSUE_ID}>{children}</FileViewerProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  return queryClient;
}

function chips() {
  return [...container.querySelectorAll('[data-workspace-file-link="true"]')];
}

function chipPaths() {
  return chips().map((chip) => chip.getAttribute("data-workspace-file-path"));
}

beforeEach(() => {
  mockAvailability.mockReset();
  mockNavigate.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("WorkspaceFileMarkdownBody availability gating", () => {
  it("renders plain inline code until the batch confirms the reference", async () => {
    let resolveBatch: ((value: WorkspaceFileAvailabilityResponse) => void) | undefined;
    mockAvailability.mockReturnValue(new Promise((resolve) => { resolveBatch = resolve; }));

    render(<WorkspaceFileMarkdownBody>{"Check `ui/src/a.ts:42` please."}</WorkspaceFileMarkdownBody>);

    // Pending: no chip, no icon, no button role — just code.
    expect(chips()).toHaveLength(0);
    expect(container.querySelector("code")?.textContent).toBe("ui/src/a.ts:42");
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector('[role="button"]')).toBeNull();

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(1));
    act(() => resolveBatch!(respondWith([openable("ui/src/a.ts")])));

    await waitForExpectation(() => expect(chipPaths()).toEqual(["ui/src/a.ts"]));
  });

  it("keeps unavailable, denied, and unsupported references as plain code", async () => {
    mockAvailability.mockResolvedValue(respondWith([
      unavailable("ui/src/missing.ts", "not_found"),
      unavailable("ui/src/denied.ts", "forbidden"),
      unavailable("ui/src/remote.ts", "unsupported_resource"),
    ]));

    render(
      <WorkspaceFileMarkdownBody>
        {"See `ui/src/missing.ts:1`, `ui/src/denied.ts:2` and `ui/src/remote.ts:3`."}
      </WorkspaceFileMarkdownBody>,
    );

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(chips()).toHaveLength(0);
    expect(container.querySelectorAll("code")).toHaveLength(3);
  });

  it("fails closed when the availability batch errors", async () => {
    mockAvailability.mockRejectedValue(new Error("boom"));

    render(<WorkspaceFileMarkdownBody>{"Check `ui/src/a.ts:42`."}</WorkspaceFileMarkdownBody>);

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(chips()).toHaveLength(0);
    expect(container.querySelector("code")?.textContent).toBe("ui/src/a.ts:42");
  });

  it("checks a reference duplicated across comments exactly once", async () => {
    mockAvailability.mockImplementation(echoOpenable);

    render(
      <>
        <WorkspaceFileMarkdownBody>{"First `ui/src/a.ts:1`."}</WorkspaceFileMarkdownBody>
        <WorkspaceFileMarkdownBody>{"Second `ui/src/a.ts:1` again."}</WorkspaceFileMarkdownBody>
        <WorkspaceFileMarkdownBody>{"Third `ui/src/a.ts:9` at another line."}</WorkspaceFileMarkdownBody>
      </>,
    );

    await waitForExpectation(() => expect(chipPaths()).toHaveLength(3));
    // One coalesced request; the line suffix is not part of the lookup, so the
    // three references collapse to a single query.
    expect(mockAvailability).toHaveBeenCalledTimes(1);
    expect(mockAvailability.mock.calls[0]![1]).toEqual([
      { path: "ui/src/a.ts", workspace: "auto", projectId: null, workspaceId: null },
    ]);
  });

  it("chunks more than 100 unique references", async () => {
    mockAvailability.mockImplementation(echoOpenable);
    const paths = Array.from({ length: 150 }, (_, index) => `ui/src/file-${index}.ts`);

    render(
      <WorkspaceFileMarkdownBody>
        {paths.map((path) => `\`${path}\``).join(" ")}
      </WorkspaceFileMarkdownBody>,
    );

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(2));
    const sizes = mockAvailability.mock.calls.map((call) => (call[1] as FileResourceQuery[]).length);
    expect(sizes).toEqual([100, 50]);
    await waitForExpectation(() => expect(chips()).toHaveLength(150));
  });

  it("runs at most two availability chunks concurrently", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const resolveRequests: Array<() => void> = [];
    mockAvailability.mockImplementation((_issueId: string, queries: FileResourceQuery[]) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      return new Promise<WorkspaceFileAvailabilityResponse>((resolve) => {
        resolveRequests.push(() => {
          activeRequests -= 1;
          resolve(respondWith(queries.map((query) => openable(query.path))));
        });
      });
    });
    const paths = Array.from({ length: 250 }, (_, index) => `ui/src/file-${index}.ts`);

    render(
      <WorkspaceFileMarkdownBody>
        {paths.map((path) => `\`${path}\``).join(" ")}
      </WorkspaceFileMarkdownBody>,
    );

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(maxActiveRequests).toBe(2);

    act(() => resolveRequests[0]!());
    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(3));
    expect(activeRequests).toBe(2);
    expect(maxActiveRequests).toBe(2);

    act(() => {
      resolveRequests[1]!();
      resolveRequests[2]!();
    });
    await waitForExpectation(() => expect(chips()).toHaveLength(250));
    expect(maxActiveRequests).toBe(2);
  });

  it("checks only unseen references when a new comment arrives", async () => {
    mockAvailability.mockImplementation(echoOpenable);

    const first = <WorkspaceFileMarkdownBody>{"First `ui/src/a.ts:1`."}</WorkspaceFileMarkdownBody>;
    const queryClient = render(first);
    await waitForExpectation(() => expect(chipPaths()).toEqual(["ui/src/a.ts"]));
    expect(mockAvailability).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <FileViewerProvider issueId={ISSUE_ID}>
              {first}
              <WorkspaceFileMarkdownBody>{"New `ui/src/a.ts:1` and `ui/src/b.ts:2`."}</WorkspaceFileMarkdownBody>
            </FileViewerProvider>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(2));
    expect(mockAvailability.mock.calls[1]![1]).toEqual([
      { path: "ui/src/b.ts", workspace: "auto", projectId: null, workspaceId: null },
    ]);
  });

  it("binds the confirmed project workspace to the chip and opens it on click", async () => {
    mockAvailability.mockResolvedValue(respondWith([
      {
        query: { path: "ui/src/a.ts", workspace: "auto", projectId: null, workspaceId: null },
        openable: true,
        resource: resource({
          workspaceKind: "project_workspace",
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          projectName: "Paperclip App",
        }),
      },
    ]));

    render(<WorkspaceFileMarkdownBody>{"Check `ui/src/a.ts:42`."}</WorkspaceFileMarkdownBody>);
    await waitForExpectation(() => expect(chips()).toHaveLength(1));

    const chip = chips()[0] as HTMLAnchorElement;
    const search = new URL(chip.href, window.location.href).searchParams;
    expect(search.get("file")).toBe("ui/src/a.ts");
    expect(search.get("line")).toBe("42");
    expect(search.get("workspace")).toBe("project");
    expect(search.get("projectId")).toBe(PROJECT_ID);
    expect(search.get("workspaceId")).toBe(WORKSPACE_ID);

    act(() => {
      chip.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });

    expect(mockNavigate).toHaveBeenCalled();
    const target = mockNavigate.mock.calls[0]![0] as { search: string };
    const opened = new URLSearchParams(target.search);
    expect(opened.get("file")).toBe("ui/src/a.ts");
    expect(opened.get("workspace")).toBe("project");
    expect(opened.get("projectId")).toBe(PROJECT_ID);
    expect(opened.get("workspaceId")).toBe(WORKSPACE_ID);
  });

  it("still batches under StrictMode's remount", async () => {
    mockAvailability.mockImplementation(echoOpenable);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    act(() => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <FileViewerProvider issueId={ISSUE_ID}>
                <WorkspaceFileMarkdownBody>{"Check `ui/src/a.ts:42`."}</WorkspaceFileMarkdownBody>
              </FileViewerProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </StrictMode>,
      );
    });

    await waitForExpectation(() => expect(chipPaths()).toEqual(["ui/src/a.ts"]));
    expect(mockAvailability).toHaveBeenCalledTimes(1);
  });

  it("rechecks after the issue's file resources are invalidated", async () => {
    mockAvailability.mockImplementation(echoOpenable);
    const queryClient = render(<WorkspaceFileMarkdownBody>{"Check `ui/src/a.ts:1`."}</WorkspaceFileMarkdownBody>);
    await waitForExpectation(() => expect(chips()).toHaveLength(1));
    expect(mockAvailability).toHaveBeenCalledTimes(1);

    mockAvailability.mockResolvedValue(respondWith([unavailable("ui/src/a.ts", "not_found")]));
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["issues", "file-resources", ISSUE_ID] });
    });

    await waitForExpectation(() => expect(mockAvailability).toHaveBeenCalledTimes(2));
    await waitForExpectation(() => expect(chips()).toHaveLength(0));
  });
});
