import type { AgentLifecycleOperation, AgentLifecycleState } from "@paperclipai/shared";
import type { LifecycleCommand } from "../domain/policy.js";

export interface LifecycleAgent {
  id: string;
  companyId: string;
  lifecycleState: AgentLifecycleState;
  lifecycleVersion: number;
  lifecycleRequiredPluginIds: string[] | null;
  lifecycleError: string | null;
  lifecycleOperation: AgentLifecycleOperation | null;
}

export interface LifecycleStore {
  get(id: string): Promise<LifecycleAgent | null>;
  change(id: string, command: LifecycleCommand, options?: { version?: number; owner?: string; reason?: string }): Promise<LifecycleAgent | null>;
  claim(id: string, owner: string, now: Date): Promise<LifecycleAgent | null>;
  renew(agent: LifecycleAgent, owner: string, now: Date): Promise<boolean>;
  setRequiredPlugins(agent: LifecycleAgent, owner: string, pluginIds: string[]): Promise<boolean>;
  completeHost(agent: LifecycleAgent, owner: string): Promise<boolean>;
  completePlugin(agent: LifecycleAgent, owner: string, pluginId: string): Promise<boolean>;
  defer(agent: LifecycleAgent, owner: string, error: string | null, now: Date): Promise<boolean>;
  pending(limit: number, now: Date): Promise<string[]>;
}

export interface LifecycleDriver {
  requiredPluginIds(agent: LifecycleAgent): Promise<string[]>;
  runHost(agent: LifecycleAgent): Promise<"complete" | "pending">;
  runPlugin(agent: LifecycleAgent, pluginId: string): Promise<"complete" | "pending">;
  /** Notify the scheduler only after readiness has committed. */
  onReady?(agent: LifecycleAgent): Promise<void>;
}

export interface LifecycleFailure {
  stage: "claim" | "renew" | "select_plugins" | "save_plugins" | "host" | "plugin"
    | "complete_host" | "complete_plugin" | "transition" | "defer" | "scan" | "policy_scan" | "ready";
  agentId?: string;
  companyId?: string;
  phase?: AgentLifecycleState;
  operationId?: string;
  version?: number;
  pluginId?: string;
}
