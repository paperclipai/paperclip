/**
 * LET-326 Phase 4A frontend client for the read-only `/api/sandbox` REST + SSE
 * read-models added in LET-314 / LET-323.
 *
 * Read-only on both ends. This module never issues writes; only GET endpoints
 * (`/providers`, `/leases`, plus the SSE stream) are wrapped here. Any future
 * preview-only decision endpoints (e.g. `validate`, `previewEgress`) would
 * land in a separate, explicitly-labeled module so the read-only property of
 * this client stays explicit in code and so the `previewOnly` chip wiring
 * lives next to the call site it gates.
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

export interface SandboxPreviewAdrPointer {
  /** Issue identifier of the buy-vs-build ADR — `LET-328`. */
  id: string;
  /** Route the UI can deep-link to (`/issues/LET-328`). */
  href: string;
  /** One-line ADR summary surfaced alongside the banner. */
  summary: string;
}

export interface SandboxSnapshotMeta {
  previewOnly: true;
  generatedAt: string;
  /**
   * LET-352: stable preview-notice copy mirrored by the UI banner. Clients
   * that show their own banner should prefer this string so server-side
   * wording stays the source of truth.
   */
  notice?: string;
  /**
   * LET-352: pointer to the buy-vs-build ADR. Optional because older
   * server builds may not surface it yet.
   */
  adr?: SandboxPreviewAdrPointer;
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
