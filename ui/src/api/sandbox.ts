/**
 * LET-326 Phase 4A frontend client for the read-only `/api/sandbox` REST + SSE
 * read-models added in LET-314 / LET-323.
 *
 * Preview-only consumer. This module never issues writes. The `validate` and
 * `previewEgress` calls hit POST endpoints, but the server has tagged both as
 * `previewOnly: true` (no Docker run, no socket open, no DNS) — they only
 * compute redacted decisions. UI callers that wrap these MUST surface the
 * `previewOnly` chip on results so operators are not misled.
 */

import type { EnvironmentLease } from "@paperclipai/shared";
import { api } from "./client";

/**
 * "Truth" label as defined by the backend read-model in
 * server/src/services/sandbox/read-model.ts. The UI maps these to the
 * Backend-backed / Backend-derived / Preview chip vocabulary.
 */
export type SandboxLeaseTruth = "backend-backed" | "derived" | "preview";

export type SandboxLeaseSandboxState =
  | "requested"
  | "provisioning"
  | "running"
  | "collecting"
  | "cleanup"
  | "expired"
  | "failed";

export interface SandboxProviderDescriptor {
  provider: string;
  kind: "builtin";
  enabled: boolean;
  previewOnly: boolean;
}

export interface SandboxEgressPreview {
  mode: string | null;
  allowLoopback: boolean | null;
  egressAllowlistCount: number;
  dnsAllowlistCount: number;
  allowInboundPortCount: number;
  truth: "preview";
}

export interface SandboxArtifactSummary {
  present: boolean;
  count: number;
}

export interface SandboxLeaseReadModel {
  id: string;
  companyId: string;
  environmentId: string;
  executionWorkspaceId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;

  status: EnvironmentLease["status"];
  leasePolicy: EnvironmentLease["leasePolicy"];

  provider: string | null;
  providerLeaseId: string | null;
  kind: string | null;

  sandboxState: SandboxLeaseSandboxState | null;

  capabilities: Record<string, unknown> | null;
  quotas: Record<string, unknown> | null;
  network: Record<string, unknown> | null;
  egressPreview: SandboxEgressPreview | null;
  policyHash: string | null;
  artifacts: SandboxArtifactSummary;

  truth: SandboxLeaseTruth;
  providerEnabled: boolean;

  failureReason: string | null;
  cleanupStatus: EnvironmentLease["cleanupStatus"];

  acquiredAt: string;
  lastUsedAt: string;
  expiresAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxSnapshotMeta {
  previewOnly: true;
  generatedAt: string;
}

export interface SandboxProvidersResponse extends SandboxSnapshotMeta {
  providers: SandboxProviderDescriptor[];
}

export interface SandboxLeaseListResponse extends SandboxSnapshotMeta {
  count: number;
  leases: SandboxLeaseReadModel[];
}

export interface SandboxLeaseGetResponse extends SandboxSnapshotMeta {
  lease: SandboxLeaseReadModel;
}

export interface SandboxLeaseFilters {
  status?: EnvironmentLease["status"];
  environmentId?: string;
  provider?: string;
  limit?: number;
}

export const sandboxApi = {
  listProviders: (companyId: string) =>
    api.get<SandboxProvidersResponse>(`/companies/${companyId}/sandbox/providers`),
  listLeases: (companyId: string, filters?: SandboxLeaseFilters) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.environmentId) params.set("environmentId", filters.environmentId);
    if (filters?.provider) params.set("provider", filters.provider);
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<SandboxLeaseListResponse>(
      `/companies/${companyId}/sandbox/leases${qs ? `?${qs}` : ""}`,
    );
  },
  getLease: (companyId: string, leaseId: string) =>
    api.get<SandboxLeaseGetResponse>(`/companies/${companyId}/sandbox/leases/${leaseId}`),
};
