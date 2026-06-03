import type { LinkConfig, LinkSide } from "../types.js";
import type { BridgeStore } from "../store/types.js";
import type { PaperclipApi } from "../paperclip/types.js";
import type { HermesConnector, InboundMessage } from "../hermes/types.js";
import { bridgeMsgId, bridgeOriginMarker } from "./envelope.js";
import { classifyItem } from "./classify.js";

export interface SyncDeps {
  api: PaperclipApi;
  store: BridgeStore;
  hermes: HermesConnector;
  link: LinkConfig;
}

function peerOf(link: LinkConfig, companyId: string): { self: LinkSide; peer: LinkSide } {
  return companyId === link.companyA.companyId
    ? { self: link.companyA, peer: link.companyB }
    : { self: link.companyB, peer: link.companyA };
}

/** One pass over both channel-issues: detect new outbound items, classify,
 *  mirror routine items to the peer + Telegram notify. Commitment items are
 *  routed to the gate in a later task (here they are skipped, not mirrored). */
export async function syncLink(deps: SyncDeps): Promise<void> {
  for (const side of [deps.link.companyA, deps.link.companyB]) {
    await syncSide(deps, side.companyId);
  }
}

async function syncSide(deps: SyncDeps, sourceCompanyId: string): Promise<void> {
  const { api, store, hermes, link } = deps;
  const { self, peer } = peerOf(link, sourceCompanyId);
  const since = await store.getCursor(link.linkId, self.channelIssueId);
  const comments = await api.listComments(self.channelIssueId, since ?? undefined);

  let maxTs = since;
  for (const c of comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    maxTs = !maxTs || c.createdAt > maxTs ? c.createdAt : maxTs;

    // loop prevention: skip bridge-authored items
    if (c.metadata && c.metadata.bridgeOrigin) continue;
    // idempotency: skip already-mirrored sources
    if (await store.findMappingBySource(c.id)) continue;

    const item = { id: c.id, companyId: sourceCompanyId, issueId: self.channelIssueId, kind: "msg" as const, body: c.body, ts: c.createdAt, metadata: c.metadata };
    const classification = classifyItem(item);
    if (classification === "commitment") {
      const gateId = bridgeMsgId();
      const approval = await api.createApproval(sourceCompanyId, { kind: "request_board_approval", summary: `Commitment via partner channel: ${c.body.slice(0, 140)}` });
      await store.putPendingApproval({ approvalId: approval.id, linkId: link.linkId, sourceCompanyId, sourceItemId: c.id, bridgeMsgId: gateId, body: c.body, state: "pending", createdAt: c.createdAt });
      await store.putMapping({ bridgeMsgId: gateId, sourceItemId: c.id, mirroredItemId: "", flags: { mirrored: false, notified: true, emailed: false } });
      await hermes.send({ bridgeMsgId: gateId, channel: "telegram", to: link.transport.telegramChat, approvalId: approval.id, body: `⛔ ${self.label} → ${peer.label} COMMITMENT (approve/reject): ${c.body}`, linkId: link.linkId });
      continue; // held — no mirror until approval resolves
    }

    const id = bridgeMsgId();
    const mirrored = await api.postComment(peer.channelIssueId, `**[${self.label}]** ${c.body}`, bridgeOriginMarker(sourceCompanyId));
    await store.putMapping({ bridgeMsgId: id, sourceItemId: c.id, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: false, emailed: false } });

    await hermes.send({ bridgeMsgId: id, channel: "telegram", to: link.transport.telegramChat, body: `📨 ${self.label} → ${peer.label}: ${c.body}`, linkId: link.linkId });
    await store.putMapping({ bridgeMsgId: id, sourceItemId: c.id, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: true, emailed: false } });
  }

  if (maxTs && maxTs !== since) await store.setCursor(link.linkId, self.channelIssueId, maxTs);
}

/** Resolve a held commitment after a board/Telegram decision.
 *  approve -> mirror to peer + email formal record + confirmation on both sides.
 *  reject  -> rejection comment on the sender's channel-issue. */
export async function resolveApprovalDecision(deps: SyncDeps, approvalId: string, decision: "approve" | "reject"): Promise<void> {
  const { api, store, hermes, link } = deps;
  const pending = await store.getPendingApproval(approvalId);
  if (!pending || pending.state !== "pending") return; // idempotent / unknown
  const { self, peer } = peerOf(link, pending.sourceCompanyId);

  await api.resolveApproval(approvalId, decision);
  await store.setApprovalState(approvalId, decision === "approve" ? "approved" : "rejected");

  if (decision === "reject") {
    await api.postComment(self.channelIssueId, `❌ Commitment rejeté par le board (réf. ${approvalId}). Non transmis au partenaire.`, bridgeOriginMarker(peer.companyId));
    return;
  }

  // approved: mirror + email formal record + confirmations
  const mirrored = await api.postComment(peer.channelIssueId, `**[${self.label}]** ✅ ${pending.body}`, bridgeOriginMarker(pending.sourceCompanyId));
  await store.putMapping({ bridgeMsgId: pending.bridgeMsgId, sourceItemId: pending.sourceItemId, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: true, emailed: true } });
  await hermes.send({ bridgeMsgId: pending.bridgeMsgId, channel: "email", to: link.transport.emailB, subject: `Engagement confirmé — ${self.label}`, body: `${pending.body}\n\n(Approbation board réf. ${approvalId})`, approvalId, linkId: link.linkId });
  await api.postComment(self.channelIssueId, `✅ Commitment approuvé (réf. ${approvalId}) — transmis au partenaire par email.`, bridgeOriginMarker(peer.companyId));
}

/** Inbound from Hermes (Telegram reply / inbound email / approve-button).
 *  Approval decisions resolve the gate; plain messages post onto a channel-issue. */
export async function handleInbound(deps: SyncDeps, msg: InboundMessage): Promise<void> {
  if (msg.approvalDecision) {
    await resolveApprovalDecision(deps, msg.approvalDecision.approvalId, msg.approvalDecision.decision);
    return;
  }
  // Plain inbound from the external partner -> post on company B's channel-issue
  // (company B is the externally-reachable partner side by convention).
  await deps.api.postComment(
    deps.link.companyB.channelIssueId,
    `**[inbound:${msg.channel}]** ${msg.body}`,
    bridgeOriginMarker(deps.link.companyA.companyId),
  );
}
