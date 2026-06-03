import type { LinkConfig, LinkSide } from "../types.js";
import type { BridgeStore } from "../store/types.js";
import type { PaperclipApi } from "../paperclip/types.js";
import type { HermesConnector } from "../hermes/types.js";
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
    if (classification === "commitment") continue; // handled by the gate (later task)

    const id = bridgeMsgId();
    const mirrored = await api.postComment(peer.channelIssueId, `**[${self.label}]** ${c.body}`, bridgeOriginMarker(sourceCompanyId));
    await store.putMapping({ bridgeMsgId: id, sourceItemId: c.id, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: false, emailed: false } });

    await hermes.send({ bridgeMsgId: id, channel: "telegram", to: link.transport.telegramChat, body: `📨 ${self.label} → ${peer.label}: ${c.body}`, linkId: link.linkId });
    await store.putMapping({ bridgeMsgId: id, sourceItemId: c.id, mirroredItemId: mirrored.id, flags: { mirrored: true, notified: true, emailed: false } });
  }

  if (maxTs && maxTs !== since) await store.setCursor(link.linkId, self.channelIssueId, maxTs);
}
