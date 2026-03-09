// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { KnowledgeItem } from "@paperclipai/shared";

const invalidateQueries = vi.fn();
const pushToast = vi.fn();
const mutate = vi.fn();

function knowledgeItem(
  overrides: Partial<KnowledgeItem> & Pick<KnowledgeItem, "id" | "title">
): KnowledgeItem {
  const now = new Date("2026-03-07T00:00:00.000Z");

  return {
    companyId: "company-1",
    kind: "note",
    summary: null,
    body: null,
    assetId: null,
    sourceUrl: null,
    asset: null,
    contentText: null,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    const key = String(queryKey[0]);
    if (key === "knowledge") {
      return {
        data: [knowledgeItem({ id: "knowledge-1", title: "Billing runbook" })],
      };
    }
    return {
      data: [
        {
          id: "attach-1",
          issueId: "issue-1",
          knowledgeItemId: "knowledge-1",
          knowledgeItem: knowledgeItem({ id: "knowledge-1", title: "Billing runbook" }),
        },
      ],
      isLoading: false,
    };
  },
  useMutation: () => ({ isPending: false, mutate }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock("./KnowledgeAttachDialog", () => ({
  KnowledgeAttachDialog: ({ title }: { title: string }) => (
    <div data-dialog-title={title}>dialog</div>
  ),
}));

vi.mock("./IssueKnowledgeCompactRow", () => ({
  IssueKnowledgeCompactRow: ({ knowledgeItem }: { knowledgeItem: KnowledgeItem }) => (
    <div>{knowledgeItem.title}</div>
  ),
}));

describe("IssueKnowledgePanel", () => {
  it("labels the attach action as knowledge", async () => {
    const { IssueKnowledgePanel } = await import("./IssueKnowledgePanel");

    const markup = renderToStaticMarkup(
      <IssueKnowledgePanel companyId="company-1" issueId="issue-1" />
    );

    expect(markup).toContain("Attach knowledge");
    expect(markup).not.toContain("Attach note");
  });
});
