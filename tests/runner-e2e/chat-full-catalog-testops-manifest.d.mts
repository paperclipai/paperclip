import type { CatalogCase } from './chat-completion-testops-contract.mjs';
export const catalogTargetSha: string;
export const catalogLauncherSha256: string;
export const catalogManifestSha256: string;
export const fullCatalogPlanName: string;
export const fullCatalogCases: readonly Readonly<CatalogCase>[];
export function companySecretBindingApprovalMetadata(declaration: Record<string, unknown>):
  { optionalCompanySecretBindingApproval?: true; expectedHumanMessageCount?: 2 };
export function validateCompanySecretBindingApprovalSource(row: Record<string, unknown>, task: Record<string, unknown>): void;
