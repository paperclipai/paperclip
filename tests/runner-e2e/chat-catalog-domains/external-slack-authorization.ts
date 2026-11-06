import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import {
  selectedExternalCredential,
  type ProviderBinding,
} from "./external-fixtures.js";
export interface SlackAuthorizationReceipt {
  ok: boolean;
  identityMatches: boolean;
  code: "ok" | "token_expired" | "token_revoked" | "invalid_auth" | "other";
}
export function slackAuthorizationReceipt(
  value: unknown,
  binding: ProviderBinding,
): SlackAuthorizationReceipt {
  const row = value as
    | { ok?: unknown; error?: unknown; team_id?: unknown; user_id?: unknown }
    | undefined;
  if (row?.ok === true)
    return {
      ok: true,
      identityMatches:
        row.team_id === binding.prerequisites.workspaceId &&
        row.user_id === binding.prerequisites.botUserId,
      code: "ok",
    };
  const code = ["token_expired", "token_revoked", "invalid_auth"].includes(
    String(row?.error),
  )
    ? (row!.error as "token_expired" | "token_revoked" | "invalid_auth")
    : "other";
  return { ok: false, identityMatches: false, code };
}
/** One fixed official auth probe, selected private refs only; unknown account
 * metadata and response bodies never escape this sensitive Node transport. */
export async function probeSlackAuthorization(
  ctx: ChatCatalogContext,
  binding: ProviderBinding,
  field: "botTokenEnv" | "repairBotTokenEnv",
): Promise<SlackAuthorizationReceipt> {
  const token = selectedExternalCredential(ctx, binding, field);
  try {
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error();
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 65536) throw new Error();
    return slackAuthorizationReceipt(
      JSON.parse(bytes.toString("utf8")),
      binding,
    );
  } catch {
    throw new Error(
      "Setup blocker: selected Slack authorization probe unavailable; private response withheld",
    );
  }
}
