import type {
  CatalogTeam,
  CatalogTeamFileDetail,
  CatalogTeamImportOptions,
  CatalogTeamImportPreviewResult,
  CatalogTeamInstallOptions,
  CatalogTeamInstallResult,
  CatalogTeamKind,
  InstalledCatalogTeam,
} from "@paperclipai/shared";
import { api } from "./client";

export interface TeamCatalogListQuery {
  kind?: CatalogTeamKind;
  category?: string;
  q?: string;
}

/**
 * Client for the Phase E teams-catalog API (server/src/routes/teams-catalog.ts).
 *
 * The preview/install bodies mirror `catalogTeamPreviewSchema` /
 * `catalogTeamInstallSchema` exactly. Several richer fields the Phase F design
 * imagined (per-source policy maps, skill-plan overrides) are not
 * accepted by the shipped strict schema, so the UI derives those affordances
 * client-side and degrades gracefully — see TeamCatalog.tsx.
 */
export const teamCatalogApi = {
  catalogList: (query: TeamCatalogListQuery = {}) => {
    const params = new URLSearchParams();
    if (query.kind) params.set("kind", query.kind);
    if (query.category) params.set("category", query.category);
    if (query.q) params.set("q", query.q);
    const search = params.toString();
    return api.get<CatalogTeam[]>(`/teams/catalog${search ? `?${search}` : ""}`);
  },
  catalogDetail: (catalogRef: string) =>
    api.get<CatalogTeam>(`/teams/catalog/${encodeURIComponent(catalogRef)}`),
  installed: (companyId: string) =>
    api.get<InstalledCatalogTeam[]>(
      `/companies/${encodeURIComponent(companyId)}/teams/catalog/installed`,
    ),
  catalogFile: (catalogRef: string, relativePath = "TEAM.md") =>
    api.get<CatalogTeamFileDetail>(
      `/teams/catalog/${encodeURIComponent(catalogRef)}/files?path=${encodeURIComponent(relativePath)}`,
    ),
  preview: (companyId: string, catalogRef: string, options: CatalogTeamImportOptions = {}) =>
    api.post<CatalogTeamImportPreviewResult>(
      `/companies/${encodeURIComponent(companyId)}/teams/catalog/${encodeURIComponent(catalogRef)}/preview`,
      options,
    ),
  install: (companyId: string, catalogRef: string, options: CatalogTeamInstallOptions = {}) =>
    api.post<CatalogTeamInstallResult>(
      `/companies/${encodeURIComponent(companyId)}/teams/catalog/${encodeURIComponent(catalogRef)}/install`,
      options,
    ),
};
