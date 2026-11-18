import type { AiConnectionAccountIdentity } from "@paperclipai/shared";
import { readUsage } from "./ai-connection-usage.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0
  && value.length <= 254 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
class AuthenticationRequired extends Error {
  readonly code = "authentication_required";
  constructor() { super("authentication_required"); }
}

export async function readOpenAiAccountIdentity(
  credential: string,
  request: typeof fetch,
): Promise<Pick<AiConnectionAccountIdentity, "status" | "accountLabel" | "organizationLabel" | "errorCode" | "message">> {
  let auth: Record<string, unknown>;
  try { auth = object(JSON.parse(credential)); }
  catch { throw new AuthenticationRequired(); }
  const tokens = object(auth.tokens);
  const accessToken = tokens.access_token ?? auth.accessToken;
  const accountId = label(tokens.account_id ?? auth.accountId);
  if (typeof accessToken !== "string" || !accessToken.trim() || accessToken.length > 32768
    || /[\u0000-\u0020\u007f]/.test(accessToken) || !accountId) throw new AuthenticationRequired();

  const profile = await readUsage("https://chatgpt.com/backend-api/wham/accounts/check", {
    Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": accountId,
  }, request);
  const accounts: Record<string, unknown>[] = Array.isArray(profile.accounts) ? profile.accounts.map(object)
    : Object.values(object(profile.accounts)).map(value => {
      const account = object(object(value).account);
      return { ...account, id: account.account_id };
    });
  const matches = accounts.filter(account => account.id === accountId);
  const selected = matches.length === 1 ? matches[0] : undefined;
  const organizationLabel = selected && selected.is_deactivated !== true
    ? label(selected.name) ?? (selected.name == null && selected.structure === "personal" ? "Personal workspace" : null)
    : null;
  if (!organizationLabel) return { status: "unavailable", accountLabel: null, organizationLabel: null,
    errorCode: "invalid_response", message: "OpenAI did not return the selected workspace name." };
  return { status: "available", accountLabel: null, organizationLabel };
}
