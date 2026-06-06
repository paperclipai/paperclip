import { api } from "./client";
import type {
  CompanyArtifact,
  CompanyArtifactMediaKind,
  CompanyArtifactsResponse,
} from "@paperclipai/shared";

export type {
  CompanyArtifact,
  CompanyArtifactMediaKind as ArtifactMediaKind,
  CompanyArtifactsResponse,
  CompanyArtifactSource as ArtifactSource,
} from "@paperclipai/shared";

/**
 * Company-level Artifacts client (PAP-10359).
 *
 * Talks to the company-scoped artifacts projection endpoint
 * (`GET /api/companies/:companyId/artifacts`) defined by the approved
 * Artifacts plan (PAP-10353). The endpoint flattens agent-produced issue
 * documents, direct attachments, and `artifact` work products into a single
 * card-ready list so the UI never has to stitch issue-specific endpoints
 * together.
 *
 * The `CompanyArtifact` shape is imported from `@paperclipai/shared` so the
 * frontend and server stay synchronized as the contract evolves.
 */

export type ArtifactKindFilter = Exclude<CompanyArtifactMediaKind, "empty"> | "all";

export interface ListArtifactsParams {
  kind?: ArtifactKindFilter;
  projectId?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

function buildArtifactsQuery(params?: ListArtifactsParams): string {
  const search = new URLSearchParams();
  if (params?.kind && params.kind !== "all") search.set("kind", params.kind);
  if (params?.projectId) search.set("projectId", params.projectId);
  if (params?.q) search.set("q", params.q);
  if (params?.limit != null) search.set("limit", String(params.limit));
  if (params?.cursor) search.set("cursor", params.cursor);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Normalize the endpoint response. The contract is an envelope
 * (`{ artifacts, nextCursor }`), but we also tolerate a bare array so the page
 * keeps working if the backend ships the simpler shape.
 */
function normalizeArtifactsResponse(
  raw: CompanyArtifactsResponse | CompanyArtifact[],
): CompanyArtifactsResponse {
  if (Array.isArray(raw)) {
    return { artifacts: raw, nextCursor: null };
  }
  return { artifacts: raw.artifacts ?? [], nextCursor: raw.nextCursor ?? null };
}

export const artifactsApi = {
  list: async (companyId: string, params?: ListArtifactsParams): Promise<CompanyArtifactsResponse> => {
    const raw = await api.get<CompanyArtifactsResponse | CompanyArtifact[]>(
      `/companies/${companyId}/artifacts${buildArtifactsQuery(params)}`,
    );
    return normalizeArtifactsResponse(raw);
  },
};
