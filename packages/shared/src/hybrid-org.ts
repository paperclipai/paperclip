import type { OrgPrincipalType } from "./org-principal.js";

export interface HybridOrgNode {
  id: string;
  kind: OrgPrincipalType;
  name: string;
  role: string;
  title: string | null;
  status: string;
  reports: HybridOrgNode[];
}
