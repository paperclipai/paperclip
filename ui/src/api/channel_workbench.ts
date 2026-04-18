import type {
  ChannelWorkbenchExportAiResponse,
  ChannelWorkbenchEvidenceDodResponse,
  ChannelWorkbenchGateResultResponse,
  ChannelWorkbenchIssueLedgerResponse,
  ChannelWorkbenchNextActionsResponse,
  ChannelWorkbenchOverviewResponse,
  ChannelWorkbenchRerunGateResponse,
  ChannelWorkbenchRoleViewResponse,
  ChannelWorkbenchScenarioKey,
  ChannelWorkbenchSourceDocumentsResponse,
  ChannelWorkbenchSpecEditorResponse,
  ChannelWorkbenchSnapshotExportResponse,
  ChannelWorkbenchUploadEvidenceResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const channelWorkbenchApi = {
  overview: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchOverviewResponse>(
      `/companies/${companyId}/channel-workbench/overview?scenario=${encodeURIComponent(scenario)}`,
    ),
  nextActions: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchNextActionsResponse>(
      `/companies/${companyId}/channel-workbench/next-actions?scenario=${encodeURIComponent(scenario)}`,
    ),
  snapshotExport: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchSnapshotExportResponse>(
      `/companies/${companyId}/channel-workbench/snapshot-export?scenario=${encodeURIComponent(scenario)}`,
    ),
  evidenceDod: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchEvidenceDodResponse>(
      `/companies/${companyId}/channel-workbench/evidence-dod?scenario=${encodeURIComponent(scenario)}`,
    ),
  gateResult: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchGateResultResponse>(
      `/companies/${companyId}/channel-workbench/gate-result?scenario=${encodeURIComponent(scenario)}`,
    ),
  issueLedger: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchIssueLedgerResponse>(
      `/companies/${companyId}/channel-workbench/issue-ledger?scenario=${encodeURIComponent(scenario)}`,
    ),
  sourceDocuments: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchSourceDocumentsResponse>(
      `/companies/${companyId}/channel-workbench/source-documents?scenario=${encodeURIComponent(scenario)}`,
    ),
  specEditor: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchSpecEditorResponse>(
      `/companies/${companyId}/channel-workbench/spec-editor?scenario=${encodeURIComponent(scenario)}`,
    ),
  roleView: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.get<ChannelWorkbenchRoleViewResponse>(
      `/companies/${companyId}/channel-workbench/role-view?scenario=${encodeURIComponent(scenario)}`,
    ),
  rerunGate: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.post<ChannelWorkbenchRerunGateResponse>(
      `/companies/${companyId}/channel-workbench/rerun-gate?scenario=${encodeURIComponent(scenario)}`,
      {},
    ),
  exportAi: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.post<ChannelWorkbenchExportAiResponse>(
      `/companies/${companyId}/channel-workbench/export-ai?scenario=${encodeURIComponent(scenario)}`,
      {},
    ),
  uploadEvidence: (companyId: string, scenario: ChannelWorkbenchScenarioKey) =>
    api.post<ChannelWorkbenchUploadEvidenceResponse>(
      `/companies/${companyId}/channel-workbench/upload-evidence?scenario=${encodeURIComponent(scenario)}`,
      {},
    ),
};
