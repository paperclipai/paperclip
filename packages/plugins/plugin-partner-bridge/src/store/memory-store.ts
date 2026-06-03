import type { PendingApproval } from "../types.js";
import type { BridgeStore, MirrorMapping } from "./types.js";

export class MemoryStore implements BridgeStore {
  private cursors = new Map<string, string>();
  private mappings = new Map<string, MirrorMapping>();      // by sourceItemId
  private approvals = new Map<string, PendingApproval>();

  async ensure(): Promise<void> {}

  async getCursor(linkId: string, issueId: string): Promise<string | null> {
    return this.cursors.get(`${linkId}::${issueId}`) ?? null;
  }
  async setCursor(linkId: string, issueId: string, ts: string): Promise<void> {
    this.cursors.set(`${linkId}::${issueId}`, ts);
  }
  async putMapping(m: MirrorMapping): Promise<void> { this.mappings.set(m.sourceItemId, m); }
  async findMappingBySource(sourceItemId: string): Promise<MirrorMapping | null> {
    return this.mappings.get(sourceItemId) ?? null;
  }
  async putPendingApproval(p: PendingApproval): Promise<void> { this.approvals.set(p.approvalId, p); }
  async getPendingApproval(approvalId: string): Promise<PendingApproval | null> {
    return this.approvals.get(approvalId) ?? null;
  }
  async setApprovalState(approvalId: string, state: "approved" | "rejected"): Promise<void> {
    const a = this.approvals.get(approvalId);
    if (a) this.approvals.set(approvalId, { ...a, state });
  }
}
