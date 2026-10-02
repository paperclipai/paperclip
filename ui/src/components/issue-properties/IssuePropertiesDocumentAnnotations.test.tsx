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
vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => ({ data: { ...issueDocument, key: "plan" }, isLoading: false }),
}));
vi.mock("@/hooks/useIssueDocuments", () => ({ useIssueDocuments: () => ({ data: [issueDocument] }) }));
vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ hash: "" }),
}));
vi.mock("@/components/IssuePlanDecompositionsSection", () => ({ IssuePlanDecompositionsSection: () => null }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: ({ docKey }: { docKey: string }) => <span data-testid={`annotation-count-${docKey}`} />,
  IssueDocumentAnnotations: ({ doc, children }: {
    doc: Pick<IssueDocument, "key" | "latestRevisionId">;
    children: React.ReactNode;
  }) => (
    <div data-testid={`annotation-surface-${doc.key}`} data-revision-id={doc.latestRevisionId}>{children}</div>
  ),
}));

describe("issue properties document annotation mounting", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    container.remove();
  });

  it("uses the issue document key on the Plan tab", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<IssuePropertiesPlansTab issue={issue} />));
    expect(container.querySelector('[data-testid="annotation-surface-plan"]')?.getAttribute("data-revision-id"))
      .toBe("revision-1");
    await act(async () => root.unmount());
  });

  it("shows the count while collapsed and mounts the same target when expanded on Artifacts", async () => {
    const root = createRoot(container);
    await act(async () => root.render(<IssuePropertiesArtifactsTab issue={issue} />));
    expect(container.querySelector('[data-testid="annotation-count-qa-evidence"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')).toBeNull();
    const expand = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    await act(async () => expand.click());
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')?.getAttribute("data-revision-id"))
      .toBe("revision-1");
    await act(async () => root.unmount());
  });

  it("expands and scrolls the requested document into view", async () => {
    const root = createRoot(container);
    await act(async () => root.render(
      <IssuePropertiesArtifactsTab
        issue={issue}
        documentDeepLink={{ documentKey: "qa-evidence", requestId: 1 }}
      />,
    ));

    expect(container.querySelector('button[aria-expanded="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')).not.toBeNull();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    await act(async () => root.unmount());
  });

  it("does not expand an unrelated document when the requested key is missing", async () => {
    const root = createRoot(container);
    await act(async () => root.render(
      <IssuePropertiesArtifactsTab
        issue={issue}
        documentDeepLink={{ documentKey: "deleted-document", requestId: 1 }}
      />,
    ));

    expect(container.querySelector('button[aria-expanded="true"]')).toBeNull();
    expect(container.querySelector('[data-testid="annotation-surface-qa-evidence"]')).toBeNull();
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
