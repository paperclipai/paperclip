export const PAPERCLIP_MANAGED_BY = "paperclip.ai/managed-by";
export const PAPERCLIP_MANAGED_BY_VALUE = "paperclip";

export const PAPERCLIP_COMPANY_ID    = "paperclip.ai/company-id";
export const PAPERCLIP_COMPANY_SLUG  = "paperclip.ai/company-slug";
export const PAPERCLIP_AGENT_ID      = "paperclip.ai/agent-id";
export const PAPERCLIP_RUN_ID        = "paperclip.ai/run-id";
export const PAPERCLIP_ROLE          = "paperclip.ai/role";
export const PAPERCLIP_ARCHIVED      = "paperclip.ai/archived";
export const PAPERCLIP_WORKSPACE_STRATEGY = "paperclip.ai/workspace-strategy";

export const ROLE_AGENT_RUNTIME      = "agent-runtime";
export const ROLE_AGENT_WORKSPACE    = "agent-workspace";
export const ROLE_CONTROL_PLANE      = "control-plane";

export const PSS_ENFORCE = "pod-security.kubernetes.io/enforce";
export const PSS_AUDIT   = "pod-security.kubernetes.io/audit";
export const PSS_WARN    = "pod-security.kubernetes.io/warn";
export const PSS_RESTRICTED = "restricted";

export function tenantBaseLabels(input: { companyId: string; companySlug: string }): Record<string, string> {
  return {
    [PAPERCLIP_MANAGED_BY]:   PAPERCLIP_MANAGED_BY_VALUE,
    [PAPERCLIP_COMPANY_ID]:   input.companyId,
    [PAPERCLIP_COMPANY_SLUG]: input.companySlug,
  };
}
