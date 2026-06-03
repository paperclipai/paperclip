import type { PendingApproval } from "../types.js";

export interface MirrorMapping {
  bridgeMsgId: string;
  sourceItemId: string;
  mirroredItemId: string;
  flags: { mirrored: boolean; notified: boolean; emailed: boolean };
}

export interface BridgeStore {
  ensure(): Promise<void>;
  getCursor(linkId: string, issueId: string): Promise<string | null>;
  setCursor(linkId: string, issueId: string, ts: string): Promise<void>;
  putMapping(m: MirrorMapping): Promise<void>;
  findMappingBySource(sourceItemId: string): Promise<MirrorMapping | null>;
  putPendingApproval(p: PendingApproval): Promise<void>;
  getPendingApproval(approvalId: string): Promise<PendingApproval | null>;
  setApprovalState(approvalId: string, state: "approved" | "rejected"): Promise<void>;
}
