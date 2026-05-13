import type {
  MissionControlActionRiskLevel,
  MissionControlApprovalGate,
  MissionControlRiskClass,
} from "./mission-control.js";

export const TOOL_PERMISSION_CATEGORIES = [
  "read_only",
  "paperclip_write",
  "approval_flow",
  "runtime_control",
  "destructive",
  "secrets",
  "external_live",
  "generic_api",
] as const;
export type ToolPermissionCategory = (typeof TOOL_PERMISSION_CATEGORIES)[number];

export interface ToolPermissionPolicy {
  toolName: string;
  category: ToolPermissionCategory;
  summary: string;
  actionRiskLevel: MissionControlActionRiskLevel;
  riskClass: MissionControlRiskClass;
  requiredApprovalGate: MissionControlApprovalGate;
  requiresExplicitApproval: boolean;
  mutatesPaperclip: boolean;
  liveSideEffect: boolean;
  destructive: boolean;
  sensitiveData: boolean;
  preferredToolName?: string;
}

export type PaperclipApiRequestPolicy = ToolPermissionPolicy & {
  method: string;
  pathPattern: string;
};

type PolicyTemplate = Omit<ToolPermissionPolicy, "toolName">;

const readOnlyPolicy: PolicyTemplate = {
  category: "read_only",
  summary: "Read-only Paperclip lookup; no mutation or external side effect.",
  actionRiskLevel: "no_side_effect",
  riskClass: "low",
  requiredApprovalGate: "none",
  requiresExplicitApproval: false,
  mutatesPaperclip: false,
  liveSideEffect: false,
  destructive: false,
  sensitiveData: false,
};

const paperclipWritePolicy: PolicyTemplate = {
  category: "paperclip_write",
  summary: "Mutates Paperclip records only; route-level auth and checkout/status guards still apply.",
  actionRiskLevel: "paperclip_only",
  riskClass: "medium",
  requiredApprovalGate: "lead",
  requiresExplicitApproval: false,
  mutatesPaperclip: true,
  liveSideEffect: false,
  destructive: false,
  sensitiveData: false,
};

const approvalRequestPolicy: PolicyTemplate = {
  category: "approval_flow",
  summary: "Creates or links an approval/confirmation artifact; it does not grant approval by itself.",
  actionRiskLevel: "paperclip_only",
  riskClass: "medium",
  requiredApprovalGate: "none",
  requiresExplicitApproval: false,
  mutatesPaperclip: true,
  liveSideEffect: false,
  destructive: false,
  sensitiveData: false,
};

const approvalDecisionPolicy: PolicyTemplate = {
  category: "approval_flow",
  summary: "Resolves a board/user approval decision and may wake the requesting agent.",
  actionRiskLevel: "paperclip_only",
  riskClass: "high",
  requiredApprovalGate: "board",
  requiresExplicitApproval: true,
  mutatesPaperclip: true,
  liveSideEffect: false,
  destructive: false,
  sensitiveData: false,
};

const runtimeControlPolicy: PolicyTemplate = {
  category: "runtime_control",
  summary: "Starts, stops, or restarts live execution workspace runtime services.",
  actionRiskLevel: "local_only",
  riskClass: "high",
  requiredApprovalGate: "board",
  requiresExplicitApproval: true,
  mutatesPaperclip: true,
  liveSideEffect: true,
  destructive: false,
  sensitiveData: false,
};

const destructivePolicy: PolicyTemplate = {
  category: "destructive",
  summary: "Restores, deletes, unlinks, or otherwise rewrites prior state.",
  actionRiskLevel: "destructive",
  riskClass: "high",
  requiredApprovalGate: "board",
  requiresExplicitApproval: true,
  mutatesPaperclip: true,
  liveSideEffect: false,
  destructive: true,
  sensitiveData: false,
};

const genericApiPolicy: PolicyTemplate = {
  category: "generic_api",
  summary: "Unsupported raw /api escape hatch; dynamic request classification is required before execution.",
  actionRiskLevel: "external_live",
  riskClass: "critical",
  requiredApprovalGate: "board",
  requiresExplicitApproval: true,
  mutatesPaperclip: true,
  liveSideEffect: true,
  destructive: true,
  sensitiveData: false,
};

function policiesFor<TName extends string>(names: readonly TName[], template: PolicyTemplate): Record<TName, ToolPermissionPolicy> {
  return names.reduce((accumulator, toolName) => {
    accumulator[toolName] = { toolName, ...template };
    return accumulator;
  }, {} as Record<TName, ToolPermissionPolicy>);
}

const readOnlyTools = [
  "paperclipMe",
  "paperclipInboxLite",
  "paperclipListAgents",
  "paperclipGetAgent",
  "paperclipListIssues",
  "paperclipGetIssue",
  "paperclipGetHeartbeatContext",
  "paperclipListComments",
  "paperclipGetComment",
  "paperclipListIssueApprovals",
  "paperclipListDocuments",
  "paperclipGetDocument",
  "paperclipListDocumentRevisions",
  "paperclipListProjects",
  "paperclipGetProject",
  "paperclipGetIssueWorkspaceRuntime",
  "paperclipWaitForIssueWorkspaceService",
  "paperclipListGoals",
  "paperclipGetGoal",
  "paperclipListApprovals",
  "paperclipGetApproval",
  "paperclipGetApprovalIssues",
  "paperclipListApprovalComments",
  "paperclipListToolPolicies",
] as const;

const paperclipWriteTools = [
  "paperclipCreateIssue",
  "paperclipUpdateIssue",
  "paperclipCheckoutIssue",
  "paperclipReleaseIssue",
  "paperclipAddComment",
  "paperclipSuggestTasks",
  "paperclipAskUserQuestions",
  "paperclipUpsertIssueDocument",
  "paperclipLinkIssueApproval",
  "paperclipAddApprovalComment",
] as const;

const approvalRequestTools = [
  "paperclipCreateApproval",
  "paperclipRequestConfirmation",
] as const;

export const PAPERCLIP_MCP_TOOL_POLICIES: Record<string, ToolPermissionPolicy> = {
  ...policiesFor(readOnlyTools, readOnlyPolicy),
  ...policiesFor(paperclipWriteTools, paperclipWritePolicy),
  ...policiesFor(approvalRequestTools, approvalRequestPolicy),
  paperclipControlIssueWorkspaceServices: {
    toolName: "paperclipControlIssueWorkspaceServices",
    ...runtimeControlPolicy,
  },
  paperclipApprovalDecision: {
    toolName: "paperclipApprovalDecision",
    ...approvalDecisionPolicy,
  },
  paperclipRestoreIssueDocumentRevision: {
    toolName: "paperclipRestoreIssueDocumentRevision",
    ...destructivePolicy,
  },
  paperclipUnlinkIssueApproval: {
    toolName: "paperclipUnlinkIssueApproval",
    ...destructivePolicy,
    summary: "Unlinks an approval from an issue; route-level authorization still applies.",
  },
  paperclipApiRequest: {
    toolName: "paperclipApiRequest",
    ...genericApiPolicy,
  },
};

export function getPaperclipMcpToolPolicy(toolName: string): ToolPermissionPolicy {
  const policy = PAPERCLIP_MCP_TOOL_POLICIES[toolName];
  if (!policy) {
    return {
      toolName,
      ...genericApiPolicy,
      summary: "Unregistered Paperclip tool; treat as high-risk until explicitly classified.",
    };
  }
  return policy;
}

function normalizeApiPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? path;
  const withSlash = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return withSlash.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function policyForApiRequest(
  method: string,
  path: string,
  template: PolicyTemplate,
  extras: Partial<Pick<ToolPermissionPolicy, "summary" | "preferredToolName">> = {},
): PaperclipApiRequestPolicy {
  return {
    toolName: "paperclipApiRequest",
    ...template,
    ...extras,
    method: method.toUpperCase(),
    pathPattern: normalizeApiPath(path),
  };
}

export function classifyPaperclipApiRequestPolicy(method: string, path: string): PaperclipApiRequestPolicy {
  const normalizedMethod = method.trim().toUpperCase();
  const normalizedPath = normalizeApiPath(path);
  const lowerPath = normalizedPath.toLowerCase();

  if (["GET", "HEAD", "OPTIONS"].includes(normalizedMethod)) {
    if (lowerPath.includes("secret")) {
      return policyForApiRequest(normalizedMethod, normalizedPath, {
        category: "secrets",
        summary: "Reads secret/vault metadata through a generic API path; prefer named secret UI/routes.",
        actionRiskLevel: "no_side_effect",
        riskClass: "high",
        requiredApprovalGate: "compliance",
        requiresExplicitApproval: true,
        mutatesPaperclip: false,
        liveSideEffect: false,
        destructive: false,
        sensitiveData: true,
      });
    }
    return policyForApiRequest(normalizedMethod, normalizedPath, readOnlyPolicy);
  }

  if (lowerPath.includes("secret")) {
    return policyForApiRequest(normalizedMethod, normalizedPath, {
      category: "secrets",
      summary: "Mutates secret/vault configuration or secret material through a generic API path.",
      actionRiskLevel: "destructive",
      riskClass: "critical",
      requiredApprovalGate: "compliance",
      requiresExplicitApproval: true,
      mutatesPaperclip: true,
      liveSideEffect: true,
      destructive: true,
      sensitiveData: true,
    });
  }

  if (/(runtime-services|runtime-commands|workspace-commands)/i.test(lowerPath)) {
    return policyForApiRequest(normalizedMethod, normalizedPath, runtimeControlPolicy, {
      preferredToolName: "paperclipControlIssueWorkspaceServices",
    });
  }

  if (/(\/restore\b|\/rollback\b|\/archive\b|\/purge\b|\/delete\b)/i.test(lowerPath) || normalizedMethod === "DELETE") {
    return policyForApiRequest(normalizedMethod, normalizedPath, destructivePolicy);
  }

  if (/\/approvals\/[^/]+\/(approve|reject|request-revision|resubmit)$/i.test(lowerPath)) {
    return policyForApiRequest(normalizedMethod, normalizedPath, approvalDecisionPolicy, {
      preferredToolName: "paperclipApprovalDecision",
    });
  }

  if (/\/plugins\/(install|[^/]+\/(upgrade|enable|disable|actions|bridge\/action))/.test(lowerPath)
    || lowerPath === "/plugins/tools/execute") {
    return policyForApiRequest(normalizedMethod, normalizedPath, {
      category: "external_live",
      summary: "Executes or changes plugin code/worker actions through a generic API path.",
      actionRiskLevel: "external_live",
      riskClass: "high",
      requiredApprovalGate: "board",
      requiresExplicitApproval: true,
      mutatesPaperclip: true,
      liveSideEffect: true,
      destructive: false,
      sensitiveData: false,
    });
  }

  return policyForApiRequest(normalizedMethod, normalizedPath, {
    ...paperclipWritePolicy,
    riskClass: "high",
    requiredApprovalGate: "board",
    requiresExplicitApproval: true,
    summary: "Unsupported generic mutating /api request; use a named MCP tool or add a registry entry before execution.",
  });
}

export function formatToolPolicySummary(policy: ToolPermissionPolicy): string {
  const approval = policy.requiresExplicitApproval
    ? `requires ${policy.requiredApprovalGate} approval`
    : `gate ${policy.requiredApprovalGate}`;
  return `Policy: ${policy.category}; ${policy.actionRiskLevel}; ${policy.riskClass}; ${approval}.`;
}
