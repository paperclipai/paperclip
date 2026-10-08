import type { AgentLifecycleOperation, AgentLifecycleState } from "@paperclipai/shared";
import type { LifecycleCommand } from "../domain/policy.js";

export interface LifecycleAgent {
  id: string;
  companyId: string;
  lifecycleState: AgentLifecycleState;
  lifecycleVersion: number;
  lifecycleParticipants: string[] | null;
  lifecycleError: string | null;
  lifecycleOperation: AgentLifecycleOperation | null;
}

export interface LifecycleStore {
  get(id: string): Promise<LifecycleAgent | null>;
  change(id: string, command: LifecycleCommand, options?: { version?: number; owner?: string; reason?: string; participants?: string[] }): Promise<LifecycleAgent | null>;
  claim(id: string, owner: string, now: Date): Promise<LifecycleAgent | null>;
  renew(agent: LifecycleAgent, owner: string, now: Date): Promise<boolean>;
  setParticipants(agent: LifecycleAgent, owner: string, participants: string[]): Promise<boolean>;
  recordResult(agent: LifecycleAgent, owner: string, participant: string, error: string | null, now: Date): Promise<boolean>;
  pending(limit: number, now: Date): Promise<string[]>;
}

export interface LifecycleDriver {
  participants(agent: LifecycleAgent): Promise<string[]>;
  run(agent: LifecycleAgent, participant: string): Promise<"complete" | "pending">;
}
