import { useMemo } from "react";
import type { Issue } from "@paperclipai/shared";
import { IssuePropertiesArtifactsTab } from "@/components/issue-properties/IssuePropertiesArtifactsTab";
import type { LabArtifact } from "../../kit";
import { COMPANY } from "../../fixtures";
import { registerPanel } from "./panel-api";

const noop = () => {};

/**
 * The shipped Artifacts tab itself, fed through the API stub. Its grouping,
 * ordering, card routing, status wording and actions are the product's.
 */
export function PanelBody({ artifacts }: { artifacts: LabArtifact[] }) {
  // The tab reads `id` and `companyId` only (IssuePropertiesArtifactsTab.tsx:375-400).
  const issue = useMemo(() => ({ id: registerPanel(artifacts), companyId: COMPANY.id }) as Issue, [artifacts]);
  // `onOpenDocument` is what the task side panel passes: "Read document" then
  // opens a document tab instead of expanding in place (TaskSidePanel.tsx:744-749).
  return <IssuePropertiesArtifactsTab issue={issue} onOpenDocument={noop} />;
}
