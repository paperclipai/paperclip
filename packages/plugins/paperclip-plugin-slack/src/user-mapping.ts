import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "./constants.js";
import { usersLookupByEmail } from "./slack-api.js";

export interface ResolveSlackUserResult {
  slackUserId: string | null;
  source: "cache" | "slack" | "missing-email" | "slack-error";
  error?: string;
}

type Ctx = Pick<PluginContext, "http" | "logger" | "state" | "users">;

interface CachedEntry {
  slackUserId: string | null;
}

export async function resolveSlackUserId(
  ctx: Ctx,
  slackToken: string,
  paperclipUserId: string,
): Promise<ResolveSlackUserResult> {
  const stateRef = {
    scopeKind: "instance" as const,
    stateKey: STATE_KEYS.slackUser(paperclipUserId),
  };

  const cached = (await ctx.state.get(stateRef)) as CachedEntry | null;
  if (cached) {
    return { slackUserId: cached.slackUserId, source: "cache" };
  }

  const user = await ctx.users.get(paperclipUserId);
  if (!user || !user.email) {
    return { slackUserId: null, source: "missing-email" };
  }

  const lookup = await usersLookupByEmail(ctx, slackToken, user.email);
  if (!lookup.ok || !lookup.user) {
    return {
      slackUserId: null,
      source: "slack-error",
      error: lookup.error ?? "unknown_error",
    };
  }

  const slackUserId = (lookup.user as { id?: string }).id ?? null;
  await ctx.state.set(stateRef, { slackUserId });

  return { slackUserId, source: "slack" };
}
