import type { Db } from "@paperclipai/db";
import { object } from "./slack-client.js";

// Event-scoped credentials are deliberately memory-only. Recovery can use the
// personal OAuth grant or bounded history; it cannot resurrect an old action token.
const stores = new WeakMap<
  Db,
  Map<string, { token: string; expiresAt: number }>
>();
const key = (
  endpoint: string,
  workspace: string,
  user: string,
  message: string,
) => JSON.stringify([endpoint, workspace, user, message]);
export function rememberVerifiedSlackSearchEvent(
  db: Db,
  endpointId: string,
  workspaceId: string,
  body: string,
) {
  let payload;
  try {
    payload = object(JSON.parse(body));
  } catch {
    return;
  }
  const event = object(payload.event);
  if (
    payload.team_id !== workspaceId ||
    !["app_mention", "message"].includes(String(event.type)) ||
    event.bot_id ||
    typeof event.user !== "string" ||
    typeof event.ts !== "string" ||
    typeof event.action_token !== "string" ||
    event.action_token.length > 4096
  )
    return;
  let tokens = stores.get(db);
  if (!tokens) {
    tokens = new Map();
    stores.set(db, tokens);
  }
  for (const [id, entry] of tokens)
    if (entry.expiresAt <= Date.now()) tokens.delete(id);
  if (tokens.size >= 1000) tokens.delete(tokens.keys().next().value!);
  tokens.set(key(endpointId, workspaceId, event.user, event.ts), {
    token: event.action_token,
    expiresAt: Date.now() + 3 * 60_000,
  });
}
export function slackSearchActionToken(
  db: Db,
  endpoint: string,
  workspace: string,
  user: string,
  message: string,
) {
  const id = key(endpoint, workspace, user, message);
  const store = stores.get(db);
  const value = store?.get(id);
  if (!value || value.expiresAt <= Date.now()) {
    store?.delete(id);
    return null;
  }
  return value.token;
}
