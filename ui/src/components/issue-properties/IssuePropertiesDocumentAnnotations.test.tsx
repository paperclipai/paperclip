// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuePropertiesArtifactsTab } from "./IssuePropertiesArtifactsTab";
import { IssuePropertiesPlansTab } from "./IssuePropertiesPlansTab";

const issueDocument: IssueDocument = {
  id: "document-1",
  companyId: "company-1",
  issueId: "issue-1",
  key: "qa-evidence",
  title: "QA evidence",
  format: "markdown",
  body: "Shared annotation target",
  latestRevisionId: "revision-1",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  createdAt: new Date("2026-06-01T00:00:00.000Z"),
  updatedAt: new Date("2026-06-01T00:00:00.000Z"),
};

const issue = { id: "issue-1", identifier: "PAP-522", workMode: "standard" } as Issue;

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [] }) }));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: null, isLoading: false }) }));
vi.mock("@/hooks/useIssueDocuments", () => ({ useIssueDocuments: () => ({ data: [issueDocument] }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "" }) }));
vi.mock("@/components/IssuePlanDecompositionsSection", () => ({ IssuePlanDecompositionsSection: () => null }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: ({ docKey }: { docKey: string }) => <span data-testid={`annotation-count-${docKey}`} />,
  IssueDocumentAnnotations: ({ doc, children }: { doc: IssueDocument; children: React.ReactNode }) => (
    <div data-testid={`annotation-surface-${doc.key}`} data-document-id={doc.id}>{children}</div>
  ),
}));

describe("issue properties document annotation mounting", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("uses the issue document key on the Plan tab", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<IssuePropertiesPlansTab issue={issue} />));
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')?.getAttribute("data-document-id"))
      .toBe("document-1");
    await act(async () => root.unmount());
  });

  it("shows the count while collapsed and mounts the same target when expanded on Artifacts", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<IssuePropertiesArtifactsTab issue={issue} />));
    expect(container.querySelector('[data-testid="annotation-count-qa-evidence"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')).toBeNull();
    const expand = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    await act(async () => expand.click());
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')?.getAttribute("data-document-id"))
      .toBe("document-1");
    await act(async () => root.unmount());
  });
});
