import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";

export const DOT_BRIDGE_REVISION = "dot-mcp-v1" as const;
export interface DotBindingSnapshot {
  bindingId: string;
  bindingGeneration: number;
  companyId: string;
  agentId: string;
  acceptByUnixMs: number;
  expiresAtUnixMs: number;
}
export interface ExternalProviderBinding extends Omit<DotBindingSnapshot, "acceptByUnixMs" | "expiresAtUnixMs"> {
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  assignmentRevision: number;
}
export interface ExternalProviderOperation {
  requestId: string;
  bindingId: string;
  bindingGeneration: number;
  runId: string;
  normalizedSessionId: string;
  turnId: string;
  assignmentRevision: number;
  digest: string;
  action: "accept" | "tool" | "progress" | "finish" | "renew";
  input: Record<string, unknown>;
}
/** Broker port uses only the authenticated run's existing PRP command lane. */
export interface ExternalProviderPort {
  dispatch(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  settle(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  attach(send: (operation: ExternalProviderOperation) => Promise<void>, revoke?: () => Promise<void>, hasProviderCheckpoint?: boolean): Promise<() => Promise<void>>;
}
export function externalOperationDigest(action: ExternalProviderOperation["action"], input: Record<string, unknown>): string {
  return digestPaperclipSemanticContent({ action, input });
}
