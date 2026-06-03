import { randomUUID } from "node:crypto";
import type { ChannelItem, Classification, MessageEnvelope } from "../types.js";

const BRIDGE_ORIGIN_KEY = "bridgeOrigin";

export function bridgeMsgId(): string {
  return randomUUID();
}

export function buildEnvelope(item: ChannelItem, classification: Classification, id: string): MessageEnvelope {
  return {
    bridgeMsgId: id,
    sourceCompanyId: item.companyId,
    sourceItemId: item.id,
    kind: item.kind,
    classification,
    ts: item.ts,
  };
}

/** Metadata stamped onto mirrored items so the bridge never re-processes its own writes. */
export function bridgeOriginMarker(peerCompanyId: string): Record<string, unknown> {
  return { [BRIDGE_ORIGIN_KEY]: peerCompanyId };
}

export function isBridgeAuthored(item: ChannelItem): boolean {
  return Boolean(item.metadata && BRIDGE_ORIGIN_KEY in item.metadata && item.metadata[BRIDGE_ORIGIN_KEY]);
}
