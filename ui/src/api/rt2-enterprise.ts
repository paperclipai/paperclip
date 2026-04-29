import type {
  Rt2EnterpriseRolloutOverview,
  Rt2EnterpriseRolloutSettingsInput,
  Rt2EnterpriseRolloutSettingsResult,
  Rt2RolloutSsoValidationInput,
  Rt2RolloutSsoValidationResult,
  Rt2ScimApplyRequest,
  Rt2ScimApplyResult,
  Rt2ScimSyncPreviewInput,
  Rt2ScimSyncPreviewResult,
  Rt2TemplateApplicationPreview,
  Rt2TemplateApplicationResult,
} from "@paperclipai/shared";
import { api } from "./client";

export const rt2EnterpriseApi = {
  getRollout: (companyId: string) =>
    api.get<Rt2EnterpriseRolloutOverview>(`/companies/${companyId}/rt2/enterprise/rollout`),
  saveRollout: (companyId: string, input: Rt2EnterpriseRolloutSettingsInput) =>
    api.post<Rt2EnterpriseRolloutSettingsResult>(`/companies/${companyId}/rt2/enterprise/rollout`, input),
  validateSso: (companyId: string, input: Rt2RolloutSsoValidationInput) =>
    api.post<Rt2RolloutSsoValidationResult>(`/companies/${companyId}/rt2/enterprise/sso/validate`, input),
  previewScim: (companyId: string, input: Rt2ScimSyncPreviewInput) =>
    api.post<Rt2ScimSyncPreviewResult>(`/companies/${companyId}/rt2/enterprise/scim/preview`, input),
  applyScim: (companyId: string, input: Rt2ScimApplyRequest) =>
    api.post<Rt2ScimApplyResult>(`/companies/${companyId}/rt2/enterprise/scim/apply`, input),
  previewTemplate: (companyId: string, templateId: string) =>
    api.get<Rt2TemplateApplicationPreview>(`/companies/${companyId}/rt2/templates/${templateId}/preview`),
  applyTemplate: (companyId: string, templateId: string) =>
    api.post<Rt2TemplateApplicationResult>(`/companies/${companyId}/rt2/templates/${templateId}/apply`, {}),
};
