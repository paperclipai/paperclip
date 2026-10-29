// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueCaseLink } from "@/api/cases";
import { IssueCasesPanel } from "./IssueCasesPanel";

function act(callback: () => void) {
  flushSync(callback);
}

const mockCasesApi = vi.hoisted(() => ({ listForIssue: vi.fn() }));
const mockInstanceApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: mockInstanceApi }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  flushSync(() => {});
}

const links: IssueCaseLink[] = [
  {
    id: "l1",
    role: "work",
    createdAt: "2026-07-07T00:00:00.000Z",
    case: { id: "c1", identifier: "PAP-C7", title: "Launch post", caseType: "blog_post", status: "in_review" },
  },
];

describe("IssueCasesPanel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCasesApi.listForIssue.mockReset();
    mockInstanceApi.getExperimental.mockReset();
  });
  afterEach(() => container.remove());

  async function render() {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <IssueCasesPanel issueId="issue-1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    return root;
  }

  it("renders nothing when the Cases flag is off", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: false });
    mockCasesApi.listForIssue.mockResolvedValue(links);
    const root = await render();
    expect(container.textContent).toBe("");
    expect(mockCasesApi.listForIssue).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("renders linked cases with role + status when enabled", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: true });
    mockCasesApi.listForIssue.mockResolvedValue(links);
    const root = await render();
    const text = container.textContent ?? "";
    expect(text).toContain("Cases");
    expect(text).toContain("PAP-C7");
    expect(text).toContain("Launch post");
    expect(text).toContain("work");
    expect(text).toContain("in review");
    expect(container.querySelector('a[href="/PAP/cases/PAP-C7"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it("renders nothing when enabled but no cases are linked", async () => {
    mockInstanceApi.getExperimental.mockResolvedValue({ enableCases: true });
    mockCasesApi.listForIssue.mockResolvedValue([]);
    const root = await render();
    expect(container.textContent).toBe("");
    act(() => root.unmount());
  });
});
