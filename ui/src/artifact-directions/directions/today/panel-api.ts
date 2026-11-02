import { artifactReviewDocumentKey } from "@paperclipai/shared";
import type { LabArtifact } from "../../kit";
import { registerApiRoute } from "../../api-stub";
import { COMPANY } from "../../fixtures";
import { agentId, guid, isTaskDocument, toIssueDocument, toWorkProduct } from "./adapters";

/**
 * Canned answers for the five requests the real Artifacts tab makes
 * (IssuePropertiesArtifactsTab.tsx:369-400), keyed by a synthetic task id so
 * several panels with different artifact lists can share one page.
 */

const panels = new Map<string, LabArtifact[]>();
const agents = new Set<string>();

/** Registers a list and returns the task id the tab should be rendered with. */
export function registerPanel(artifacts: LabArtifact[]): string {
  const issueId = guid(`panel:${artifacts.map((a) => a.id).join(",")}`);
  panels.set(issueId, artifacts);
  for (const a of artifacts) {
    agents.add(a.author);
    if (a.run) agents.add(a.run.agent);
  }
  return issueId;
}

/**
 * The tab sorts rows by creation time. The lab hands a kit an ordered list, so
 * creation times are spaced a minute apart in that order — and start after
 * every run, because the ungrouped documents lead the real tab.
 */
const createdAt = (index: number) => new Date(Date.parse("2026-09-28T12:00:00") - index * 60_000);

const isMarkdownFile = (a: LabArtifact) => a.kind === "document" && !isTaskDocument(a);

function workProducts(artifacts: LabArtifact[]) {
  return artifacts.flatMap((a, i) => (isTaskDocument(a) ? [] : [toWorkProduct(a, createdAt(i))]));
}

function documents(artifacts: LabArtifact[]) {
  return artifacts.flatMap((a, i) => {
    if (isTaskDocument(a)) return [toIssueDocument(a, createdAt(i))];
    // The server materializes a review document for each Markdown work product;
    // the tab reads its body for the card preview.
    if (isMarkdownFile(a)) {
      return [{ ...toIssueDocument(a, createdAt(i)), key: artifactReviewDocumentKey(guid(`work-product:${a.id}`)), latestRevisionNumber: 1 }];
    }
    return [];
  });
}

function runs(artifacts: LabArtifact[]) {
  const seen = new Map<string, NonNullable<LabArtifact["run"]>>();
  for (const a of artifacts) if (a.run) seen.set(a.run.id, a.run);
  return [...seen.values()].map((run) => ({
    runId: run.id,
    status: "succeeded",
    agentId: agentId(run.agent),
    adapterType: "claude_local",
    startedAt: run.startedAt,
    finishedAt: run.startedAt,
    createdAt: run.startedAt,
    invocationSource: "assignment",
    usageJson: null,
    resultJson: null,
  }));
}

/** Only the count is read (IssueDocumentAnnotations.tsx:411-414). */
function annotations(artifacts: LabArtifact[], reviewKey: string) {
  const owner = artifacts.find((a) => artifactReviewDocumentKey(guid(`work-product:${a.id}`)) === reviewKey);
  return Array.from({ length: owner?.commentCount ?? 0 }, (_, i) => ({ id: `thread-${i}`, status: "open", anchorState: "anchored", comments: [] }));
}

registerApiRoute((pathname) => {
  if (pathname === `/api/companies/${COMPANY.id}/agents`) {
    return [...agents].map((name) => ({ id: agentId(name), companyId: COMPANY.id, name }));
  }
  const match = /^\/api\/issues\/([^/]+)\/(.+)$/.exec(pathname);
  const artifacts = match ? panels.get(match[1]) : undefined;
  if (!match || !artifacts) return undefined;
  const rest = match[2];
  if (rest === "attachments") return [];
  if (rest === "work-products") return workProducts(artifacts);
  if (rest === "documents") return documents(artifacts);
  if (rest === "runs") return runs(artifacts);
  const annotation = /^documents\/([^/]+)\/annotations$/.exec(rest);
  if (annotation) return annotations(artifacts, decodeURIComponent(annotation[1]));
  return undefined;
});
