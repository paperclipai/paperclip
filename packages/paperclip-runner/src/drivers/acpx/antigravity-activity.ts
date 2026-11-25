import type { CanonicalProviderEvent } from "../../provider-events.js";
import { antigravitySwarmChannelLabel } from "./antigravity-swarm-route.js";
import type { AcpxActivityAdapter } from "./profile-activity.js";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim().slice(0, 240) : null;

/**
 * The swarm's settings receipt (antigravity-swarm-runtime.ts `antigravitySwarmReceipt`)
 * as a run-record provider notice, through the same post-turn hook as Cursor's
 * native receipt. Only diagnostics leave: the requested and confirmed model,
 * mode, channel, CLI version and whether the CLI's own Google sign-in is the
 * connection account. No account, path, session id or instruction text.
 * Bound to this turn's request, so a receipt is never reported twice.
 */
export function antigravitySwarmReceiptNotice(before: unknown, after: unknown, requestId: string, itemId: string): CanonicalProviderEvent | null {
  const current = record(after), prior = record(before);
  if (current.lastRequestId !== requestId || prior.lastRequestId === requestId) return null;
  const receipt = record(current.antigravitySwarmReceipt);
  const requested = text(receipt.model), confirmed = text(receipt.modelName), version = text(receipt.agentVersion);
  if (!requested || !confirmed || !version) return null;
  const channel = receipt.channel === "stable" ? "stable" : "provider_default";
  const match = ["matches", "does_not_match"].includes(String(receipt.cliAccountMatchesConnection)) ? String(receipt.cliAccountMatchesConnection) : "unknown";
  const reason = match === "unknown" && ["no_connection_account", "cli_sign_in_not_found"].includes(String(receipt.cliAccountUnknownReason))
    ? String(receipt.cliAccountUnknownReason) : null;
  const details = [
    { name: "Requested model", value: requested },
    { name: "Confirmed model", value: confirmed },
    ...(text(receipt.thoughtLevel) ? [{ name: "Thinking level", value: text(receipt.thoughtLevel)! }] : []),
    { name: "Mode", value: text(receipt.mode) ?? "unknown" },
    { name: "Channel", value: channel },
    { name: "Antigravity CLI version", value: version },
    { name: "CLI account matches connection", value: match },
    ...(reason ? [{ name: "Account unknown reason", value: reason }] : []),
  ];
  return {
    eventType: "provider.notice.recorded", itemId,
    payload: { schema: "paperclip.provider.notice.v1", noticeId: itemId, severity: "info", category: "antigravity_swarm_receipt", scope: "turn",
      recoverable: true, userActionable: false,
      summary: `Swarm ran with ${confirmed} on ${antigravitySwarmChannelLabel(channel)} (Antigravity CLI ${version}).`, details },
  };
}

export const antigravityActivityAdapter: AcpxActivityAdapter = Object.freeze<AcpxActivityAdapter>({
  usageNotice: (before, after, requestId, turnId) => antigravitySwarmReceiptNotice(before, after, requestId, `${turnId}:antigravity-swarm-receipt`),
});
