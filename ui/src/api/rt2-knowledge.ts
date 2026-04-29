import type {
  Rt2ObsidianVaultExport,
  Rt2ObsidianVaultConflictResolutionInput,
  Rt2ObsidianVaultConflictResolutionResult,
  Rt2ObsidianVaultDryRunResult,
  Rt2ObsidianVaultImportApplyInput,
  Rt2ObsidianVaultImportApplyResult,
  Rt2ObsidianVaultImportPreview,
  Rt2ObsidianVaultImportPreviewInput,
  Rt2ObsidianVaultWriterSettings,
  Rt2ObsidianVaultWriterSettingsInput,
  Rt2KnowledgeProjectionResult,
  Rt2KnowledgeOperationsHealth,
  Rt2LocalBridgeHealth,
  Rt2LocalBridgeHeartbeatInput,
  Rt2LocalBridgePairingRequest,
  Rt2LocalBridgePairingResult,
  Rt2LocalBridgeQueueApplyInput,
  Rt2LocalBridgeQueueInput,
  Rt2LocalBridgeQueueItem,
  Rt2ContradictionCandidateList,
  Rt2ContradictionGenerateResult,
  Rt2ContradictionResolutionInput,
  Rt2WikiPage,
  Rt2WikiPageList,
  Rt2WikiPageType,
} from "@paperclipai/shared";
import type { Rt2DailyWikiPage } from "@paperclipai/shared";

type Rt2DailyWikiPageList = { companyId: string; pages: Rt2DailyWikiPage[] };
import { api } from "./client";

function query(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  return search.toString();
}

export const rt2KnowledgeApi = {
  listWikiPages: (companyId: string, input: { pageType?: Rt2WikiPageType; limit?: number } = {}) =>
    api.get<Rt2WikiPageList>(`/companies/${companyId}/rt2/wiki-pages?${query(input)}`),
  getWikiPage: (companyId: string, pageKey: string) =>
    api.get<Rt2WikiPage>(`/companies/${companyId}/rt2/wiki-page?pageKey=${encodeURIComponent(pageKey)}`),
  listDailyWikiPages: (companyId: string, input: { date?: string; userId?: string; projectId?: string; limit?: number } = {}) =>
    api.get<Rt2DailyWikiPageList>(`/companies/${companyId}/rt2/knowledge/daily/wiki-pages?${query(input)}`),
  getDailyWikiPage: (companyId: string, date: string, userId?: string) => {
    const params = new URLSearchParams({ date });
    if (userId) params.set("userId", userId);
    return api.get<Rt2DailyWikiPage | null>(`/companies/${companyId}/rt2/knowledge/daily/wiki-page?${params}`);
  },
  project: (companyId: string, limit = 100) =>
    api.post<Rt2KnowledgeProjectionResult>(`/companies/${companyId}/rt2/knowledge/project`, { limit }),
  projectAllDaily: (companyId: string) =>
    api.post<{ companyId: string; projectedDates: number; totalPages: number; lastProjectedAt: string }>(
      `/companies/${companyId}/rt2/knowledge/daily/rebuild`,
      {},
    ),
  exportVault: (companyId: string, input: { pageType?: Rt2WikiPageType; limit?: number } = {}) =>
    api.get<Rt2ObsidianVaultExport>(`/companies/${companyId}/rt2/knowledge/vault-export?${query(input)}`),
  getVaultWriter: (companyId: string) =>
    api.get<Rt2ObsidianVaultWriterSettings | null>(`/companies/${companyId}/rt2/knowledge/vault-writer`),
  saveVaultWriter: (companyId: string, input: Rt2ObsidianVaultWriterSettingsInput) =>
    api.post<Rt2ObsidianVaultWriterSettings>(`/companies/${companyId}/rt2/knowledge/vault-writer`, input),
  dryRunVaultWriter: (companyId: string) =>
    api.post<Rt2ObsidianVaultDryRunResult>(`/companies/${companyId}/rt2/knowledge/vault-writer/dry-run`, {}),
  getLocalBridgeHealth: (companyId: string) =>
    api.get<Rt2LocalBridgeHealth>(`/companies/${companyId}/rt2/knowledge/local-bridge/health`),
  createLocalBridgePairing: (companyId: string, input: Rt2LocalBridgePairingRequest) =>
    api.post<Rt2LocalBridgePairingResult>(`/companies/${companyId}/rt2/knowledge/local-bridge/pairing`, input),
  recordLocalBridgeHeartbeat: (companyId: string, input: Rt2LocalBridgeHeartbeatInput) =>
    api.post<Rt2LocalBridgePairingResult["bridge"]>(`/companies/${companyId}/rt2/knowledge/local-bridge/heartbeat`, input),
  listLocalBridgeQueue: (companyId: string) =>
    api.get<{ companyId: string; items: Rt2LocalBridgeQueueItem[] }>(
      `/companies/${companyId}/rt2/knowledge/local-bridge/sync-queue`,
    ),
  enqueueLocalBridgeSync: (companyId: string, input: Rt2LocalBridgeQueueInput) =>
    api.post<Rt2LocalBridgeQueueItem>(`/companies/${companyId}/rt2/knowledge/local-bridge/sync-queue`, input),
  applyLocalBridgeQueue: (companyId: string, input: Rt2LocalBridgeQueueApplyInput) =>
    api.post<Rt2LocalBridgeQueueItem>(`/companies/${companyId}/rt2/knowledge/local-bridge/sync-queue/apply`, input),
  previewVaultImport: (companyId: string, input: Rt2ObsidianVaultImportPreviewInput) =>
    api.post<Rt2ObsidianVaultImportPreview>(
      `/companies/${companyId}/rt2/knowledge/vault-import-preview`,
      input,
    ),
  applyVaultImport: (companyId: string, input: Rt2ObsidianVaultImportApplyInput) =>
    api.post<Rt2ObsidianVaultImportApplyResult>(
      `/companies/${companyId}/rt2/knowledge/vault-import-apply`,
      input,
    ),
  resolveVaultConflict: (companyId: string, input: Rt2ObsidianVaultConflictResolutionInput) =>
    api.post<Rt2ObsidianVaultConflictResolutionResult>(
      `/companies/${companyId}/rt2/knowledge/vault-conflict-resolve`,
      input,
    ),
  listContradictions: (companyId: string, input: { status?: "open" | "resolved" | "all"; projectId?: string } = {}) =>
    api.get<Rt2ContradictionCandidateList>(`/companies/${companyId}/rt2/contradictions?${query(input)}`),
  getOperationsHealth: (companyId: string) =>
    api.get<Rt2KnowledgeOperationsHealth>(`/companies/${companyId}/rt2/knowledge/operations/health`),
  generateContradictions: (companyId: string, projectId: string) =>
    api.post<Rt2ContradictionGenerateResult>(`/companies/${companyId}/rt2/contradictions/generate`, { projectId }),
  resolveContradiction: (companyId: string, candidateId: string, input: Rt2ContradictionResolutionInput) =>
    api.post<{ candidate: unknown; resolution: unknown }>(
      `/companies/${companyId}/rt2/contradictions/${candidateId}/resolve`,
      input,
    ),
};
