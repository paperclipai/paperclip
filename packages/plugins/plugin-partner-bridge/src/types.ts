export type Classification = "routine" | "commitment";
export type ItemKind = "msg" | "task" | "doc";

/** A new item observed on a channel-issue (a comment, or a doc reference). */
export interface ChannelItem {
  id: string;            // source comment id (or synthetic doc id "<issueId>:doc:<key>")
  companyId: string;     // source company
  issueId: string;       // channel-issue it appeared on
  kind: ItemKind;
  body: string;
  ts: string;            // ISO timestamp
  metadata?: Record<string, unknown>; // may carry bridgeOrigin / class / docKey
  docKey?: string;       // present when kind === "doc"
}

/** Provenance stamped onto every mirrored item (loop prevention + dedup). */
export interface MessageEnvelope {
  bridgeMsgId: string;
  sourceCompanyId: string;
  sourceItemId: string;
  kind: ItemKind;
  classification: Classification;
  ts: string;
}

export interface LinkSide { companyId: string; channelIssueId: string; label: string; }
export interface LinkConfig {
  linkId: string;
  companyA: LinkSide;
  companyB: LinkSide;
  transport: { telegramChat: string; emailA: string; emailB: string };
}

export interface PendingApproval {
  approvalId: string;
  linkId: string;
  sourceCompanyId: string;
  sourceItemId: string;
  bridgeMsgId: string;
  body: string;
  state: "pending" | "approved" | "rejected";
  createdAt: string;
}
