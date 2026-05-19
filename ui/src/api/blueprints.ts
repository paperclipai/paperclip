// LET-501 — Frontend client for the LET-498 Blueprint catalog/detail API.
//
// Scope for the C lane: read-only catalog (list) and detail (single version)
// endpoints. The instantiate endpoint stays inside the D lane wizard work
// and is intentionally NOT exposed here — the catalog/detail surfaces never
// submit instantiate from the ordinary operator path.

import type {
  BlueprintApprovalEvidence,
  BlueprintConfigSchema,
  BlueprintInstantiatePreview,
  BlueprintLifecycleStatus,
  BlueprintVersion,
} from "@paperclipai/shared";
import { api } from "./client";

// Mirrors `publicVersion(...)` in server/src/routes/blueprints.ts. The
// systemPromptTemplate / configSchema / source fields are only emitted by
// the detail endpoint, not the list endpoint.
export type BlueprintCatalogEntry = Pick<
  BlueprintVersion,
  | "ref"
  | "key"
  | "version"
  | "title"
  | "category"
  | "description"
  | "status"
  | "requiredSkillRefs"
  | "mcpBundleRefs"
  | "requiredSecretInputs"
  | "requiredProviderKeys"
  | "permissionPolicies"
  | "runtimeDefaults"
  | "budget"
  | "validationContract"
>;

export type BlueprintCatalogDetail = BlueprintCatalogEntry & {
  systemPromptTemplate: string;
  configSchema: BlueprintConfigSchema;
  source: BlueprintVersion["source"];
};

export interface BlueprintCatalogListResponse {
  enabled: boolean;
  versions: BlueprintCatalogEntry[];
}

export type {
  BlueprintApprovalEvidence,
  BlueprintInstantiatePreview,
  BlueprintLifecycleStatus,
};

export const blueprintsApi = {
  list: (companyId: string) =>
    api.get<BlueprintCatalogListResponse>(
      `/companies/${encodeURIComponent(companyId)}/blueprints`,
    ),
  get: (companyId: string, ref: string) =>
    api.get<BlueprintCatalogDetail>(
      `/companies/${encodeURIComponent(companyId)}/blueprints/${encodeURIComponent(ref)}`,
    ),
};
