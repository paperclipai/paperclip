import type {
  AgentHookActionType,
  AgentHookEventType,
  IssueStatus,
} from "../constants.js";

export type AgentHookMatchValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>;

export interface AgentHooksPermissions {
  allowCommand: boolean;
  allowWebhook: boolean;
  allowIssueAssignment: boolean;
  allowedAgentRefs: string[];
}

export interface AgentHookBaseAction {
  type: AgentHookActionType;
}

export interface AgentHookCommandAction extends AgentHookBaseAction {
  type: "command";
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface AgentHookWebhookAction extends AgentHookBaseAction {
  type: "webhook";
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface AgentHookWakeAgentAction extends AgentHookBaseAction {
  type: "wake_agent";
  agentRefs: string[];
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
  forceFreshSession?: boolean;
}

export interface AgentHookAssignIssueAction extends AgentHookBaseAction {
  type: "assign_issue";
  agentRef: string;
  issueId?: string | null;
  status?: IssueStatus | null;
  wakeAssignee?: boolean;
}

export type AgentHookAction =
  | AgentHookCommandAction
  | AgentHookWebhookAction
  | AgentHookWakeAgentAction
  | AgentHookAssignIssueAction;

export interface AgentHookRule {
  id: string;
  description?: string | null;
  enabled: boolean;
  event: AgentHookEventType | AgentHookEventType[];
  match?: Record<string, AgentHookMatchValue>;
  actions: AgentHookAction[];
}

export interface AgentHooksConfig {
  enabled: boolean;
  permissions: AgentHooksPermissions;
  rules: AgentHookRule[];
}