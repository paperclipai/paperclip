import { api } from "./client";

export type StateRepoCommit = {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  committer: string;
  date: string;
  subject: string;
};

export type StateRepoHealth = {
  configured: boolean;
  healthy: boolean;
  success: { pushedAt: string } | null;
  failure: string | null;
};

export type StateRepoRemoteConfig = {
  companyId: string;
  remoteUrl: string;
  secretId: string | null;
  secretVersion: string | null;
  updatedAt: string;
};

export type SetStateRepoRemoteInput = {
  remoteUrl: string;
  secretId?: string | null;
  secretVersion?: string | null;
};

export type RestoreResult = { restored: string[]; dryRun: boolean };

export const stateRepoApi = {
  health: (companyId: string) =>
    api.get<StateRepoHealth>(`/companies/${companyId}/state-repo/health`),
  log: (companyId: string, limit = 50) =>
    api.get<{ commits: StateRepoCommit[] }>(`/companies/${companyId}/state-repo/log?limit=${limit}`),
  getRemote: (companyId: string) =>
    api.get<{ remote: StateRepoRemoteConfig | null }>(`/companies/${companyId}/state-repo/remote`),
  setRemote: (companyId: string, data: SetStateRepoRemoteInput) =>
    api.put<{ remote: StateRepoRemoteConfig }>(`/companies/${companyId}/state-repo/remote`, data),
  disconnectRemote: (companyId: string) =>
    api.delete<{ remote: null }>(`/companies/${companyId}/state-repo/remote`),
  testMirror: (companyId: string) =>
    api.post<StateRepoHealth>(`/companies/${companyId}/state-repo/mirror/test`, {}),
  restore: (companyId: string, source: string, ref = "main", dryRun = false) =>
    api.post<RestoreResult>(`/companies/${companyId}/state-repo/restore`, { source, ref, dryRun }),
  // Bundle is a file download served with Content-Disposition; link to it directly.
  bundleHref: (companyId: string) => `/api/companies/${companyId}/state-repo/bundle`,
};
