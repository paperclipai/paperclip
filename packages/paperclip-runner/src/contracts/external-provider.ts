import { digestPaperclipSemanticContent } from "../semantic-tools/receipts.js";

export const DOT_BRIDGE_REVISION = "dot-mcp-v1" as const;
export const MUSE_BRIDGE_REVISION = "muse-v1" as const;
export interface DotBindingSnapshot {
  bindingId: string;
  bindingGeneration: number;
  companyId: string;
  agentId: string;
  acceptByUnixMs: number;
  expiresAtUnixMs: number;
}
/** Public immutable Muse authority; credentials never enter the execution input. */
export interface MuseBindingSnapshot extends DotBindingSnapshot {}
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
  action: "accept" | "tool" | "progress" | "finish" | "renew" | "request_user_input" | "consume_input";
  input: Record<string, unknown>;
}
/** Broker port uses only the authenticated run's existing PRP command lane. */
export interface ExternalProviderPort {
  dispatch(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  settle(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  /** Persist the exact answer delivery before acknowledging the Runner event. */
  inputAvailable?(event: { sourceEventId: string; payload: Record<string, unknown> }): Promise<void>;
  attach(send: (operation: ExternalProviderOperation) => Promise<void>, revoke?: () => Promise<void>, hasProviderCheckpoint?: boolean): Promise<() => Promise<void>>;
}
export function externalOperationDigest(action: ExternalProviderOperation["action"], input: Record<string, unknown>): string {
  return digestPaperclipSemanticContent({ action, input });
}
