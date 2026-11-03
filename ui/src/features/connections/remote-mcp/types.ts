import type { ChatUiError } from "@/pages/apps/chat/chat-copy";
import type { ToolCatalogEntry } from "@paperclipai/shared";

export type ToolPermission = "allowed" | "ask_first" | "off";
export type SetupStep = "access" | "connect" | "permissions" | "management" | "draft";
export type ConnectStatus = "idle" | "connecting" | "sign_in" | "returned" | "cancelled" | "oauth_failed" | "invalid_url" | "rejected" | "unreachable";
export interface RemoteMcpTool extends ToolCatalogEntry {
  broad?: boolean;
}

export interface RemoteMcpSetupState {
  step: SetupStep;
  grantKind: "user" | "organization";
  setupComplete: boolean;
  url: string;
  managementUrl?: string;
  auth: "auto" | "bearer" | "headers" | "none";
  token: string;
  headers: { id: string; name: string; value: string }[];
  connectStatus: ConnectStatus;
  connected: boolean;
  identity: string | null;
  allAgents: boolean;
  agentIds: string[];
  permissions: Record<string, ToolPermission>;
  tools: RemoteMcpTool[];
  notice: ChatUiError | null;
  refreshing: boolean;
}

export interface RemoteMcpSetupActions {
  edit: (patch: Partial<RemoteMcpSetupState>) => void;
  navigate: (step: "access" | "connect" | "permissions") => void;
  connect: () => void;
  cancelConnect: () => void;
  openProvider: (purpose: "setup" | "manage" | "sign_in") => void;
  saveExit: () => void;
  resumeDraft: () => void;
  finish: () => void;
  refresh: () => void;
  reconnect: () => void;
  disconnect: () => void;
}
