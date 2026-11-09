import type { CanonicalProviderEvent } from "../provider-events.js";
import { cursorUsageNotice } from "./acpx/cursor-usage-notice.js";

export interface ProviderNoticeOwner {
  provider?: string;
  agent?: string;
  threadId: string;
  turnId: string | null;
}

type NoticeAdapter = (raw: unknown, owner: ProviderNoticeOwner) => CanonicalProviderEvent | null;
const acpxNotices: Readonly<Record<string, NoticeAdapter | undefined>> = { cursor: cursorUsageNotice };

/** Accept only diagnostics understood by the admitted provider adapter.
 * A canonical-looking envelope is not authority to inject arbitrary events. */
export function normalizeProviderNotice(raw: unknown, owner: ProviderNoticeOwner): CanonicalProviderEvent | null {
  if (owner.provider !== "acpx" || !owner.agent || !Object.hasOwn(acpxNotices, owner.agent)) return null;
  return acpxNotices[owner.agent]?.(raw, owner) ?? null;
}
