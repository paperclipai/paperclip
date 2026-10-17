// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IssuePropertiesPlansTab } from "./IssuePropertiesPlansTab";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiFixture = vi.hoisted(() => ({
  deleteDocument: vi.fn(),
  listAcceptedPlanDecompositions: vi.fn(),
  listInteractions: vi.fn(),
}));

const planFixture = vi.hoisted(() => ({
  document: null as IssueDocument | null,
}));

vi.mock("@/api/issues", () => ({
  issuesApi: apiFixture,
}));

vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => ({ data: planFixture.document, isLoading: false }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ hash: "" }),
}));

vi.mock("@/components/IssuePlanDecompositionsSection", () => ({
  IssuePlanDecompositionsSection: () => null,
}));

vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: () => null,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const issue = {
  id: "task-1",
  companyId: "company-1",
  identifier: "PAP-1",
  title: "Plan deletion",
  workMode: "planning",
} as Issue;

function planDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-plan",
    issueId: "task-1",
    companyId: "company-1",
    key: "plan",
    title: "Plan",
    body: "# Plan",
    latestRevisionNumber: 1,
    createdAt: "2026-10-14T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    ...overrides,
  } as IssueDocument;
}

describe("IssuePropertiesPlansTab", () => {
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    apiFixture.deleteDocument.mockReset().mockResolvedValue({ ok: true });
    apiFixture.listAcceptedPlanDecompositions.mockReset().mockResolvedValue([]);
    apiFixture.listInteractions.mockReset().mockResolvedValue([]);
    planFixture.document = planDocument();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(props: { canDeleteDocuments?: boolean; onDeleted?: (documentKey: string) => void } = {}) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <IssuePropertiesPlansTab issue={issue} {...props} />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("deletes an unlocked plan through the shared document action", async () => {
    const onDeleted = vi.fn();
    await render({ canDeleteDocuments: true, onDeleted });

    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Delete Plan"]')?.click());
    expect(document.body.textContent).toContain("Delete “Plan”?");

    const confirm = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "Delete document");
    await act(async () => {
      confirm?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(apiFixture.deleteDocument).toHaveBeenCalledExactlyOnceWith("task-1", "plan");
    expect(onDeleted).toHaveBeenCalledExactlyOnceWith("plan");
  });

  it("does not offer deletion without board access or for a locked plan", async () => {
    await render();
    expect(container.querySelector('button[aria-label="Delete Plan"]')).toBeNull();

    planFixture.document = planDocument({ lockedAt: new Date("2026-10-15T12:30:00.000Z") });
    await render({ canDeleteDocuments: true });
    expect(container.querySelector('button[aria-label="Delete Plan"]')).toBeNull();
  });
});
