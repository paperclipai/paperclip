import type { ExternalObject, IssueWorkProduct } from "@paperclipai/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ArtifactRow, subjectFromWorkProduct } from "./artifacts/v1";
import { IssueRelatedWorkPanel } from "./IssueRelatedWorkPanel";
import { RichWorkProductCard } from "./task-chat/RichWorkProductCard";

function renderDisplays(state: "open" | "merged", data: Record<string, unknown>) {
  const url = "https://github.com/example/project/pull/42";
  const product: IssueWorkProduct = {
    id: "product-42", companyId: "company", issueId: "task", projectId: null,
    executionWorkspaceId: null, runtimeServiceId: null, createdByRunId: null,
    type: "pull_request", provider: "github", externalId: null, title: "Update task view", url,
    status: "active", reviewState: "none", healthStatus: "unknown", isPrimary: false, summary: null,
    metadata: { ...data, state }, createdAt: new Date(0), updatedAt: new Date(0),
  };
  const object = {
    id: "pr-42", providerKey: "github", objectType: "pull_request", statusKey: state, data,
  } as ExternalObject;
  return [
    renderToStaticMarkup(<ArtifactRow subject={subjectFromWorkProduct(product)} href={url} />),
    renderToStaticMarkup(<RichWorkProductCard workProduct={product} href={url} />),
    renderToStaticMarkup(<IssueRelatedWorkPanel externalObjects={[{
      group: { object, mentions: [], sourceLabels: [], mentionCount: 0 },
      pill: { providerKey: "github", objectType: "pull_request", statusCategory: "open", liveness: "fresh", url },
      mentionCount: 0,
      sourceLabels: [],
    }]} />),
  ];
}

it("shows the same head and merge state on the artifact row, rich card, and related work panel", () => {
  for (const html of renderDisplays("open", { headSha: "e7fce6d123456789", mergeableState: "dirty" })) {
    expect(html).toMatch(/class="font-mono">e7fce6d<\//);
    expect(html).toContain("Has conflicts");
  }
});

it("omits invalid metadata and hides merge state on closed work", () => {
  for (const html of renderDisplays("open", { headSha: "not-a-commit", mergeableState: "unknown" })) {
    expect(html).not.toContain("not-a-commit");
    expect(html).not.toContain("unknown");
  }
  for (const html of renderDisplays("merged", { headSha: "e7fce6d123456789", mergeableState: "dirty" })) {
    expect(html).not.toContain("e7fce6d");
    expect(html).not.toContain("Has conflicts");
  }
});
