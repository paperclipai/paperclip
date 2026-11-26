import type { EndpointRow, DbTransaction, LifecycleRuntimeFence, InboundRuntimeContext } from "../runtime-types.js";

import { type ChatRuntime } from "../../chat-runtime.js";

import type { Db } from "@paperclipai/db";

import {
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

type TeamsRoutesOptions = {
  runtime: Pick<ChatRuntime | ChatSdkRuntime, "get">;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
};



function microsoftTeamsServiceUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { serviceUrl?: unknown }).serviceUrl;
  return typeof value === "string" && value ? value : null;
}
export function createTeamsRoutes(db: Db, options: TeamsRoutesOptions) {
  const { runtime, runtimeCallbackEndpoint } = options;


  async function recordCurrentMicrosoftTeamsRoute(
    endpoint: EndpointRow,
    context: InboundRuntimeContext | undefined,
    threadId: string,
    raw: unknown,
    recordAcceptedActivity = true,
  ): Promise<void> {
    if (endpoint.provider !== "microsoft-teams" || !context?.endpointRuntime) {
      return;
    }
    const serviceUrl = microsoftTeamsServiceUrl(raw);
    if (!serviceUrl) return;
    await db.transaction(async (tx) => {
      const current = await runtimeCallbackEndpoint(tx, endpoint.id, context, [
        "verifying",
        "active",
      ]);
      if (!current || runtime.get(endpoint.id) !== context.endpointRuntime) {
        return;
      }
      await context.endpointRuntime.recordMicrosoftTeamsRoute(
        threadId,
        serviceUrl,
        recordAcceptedActivity ? raw : undefined,
      );
    });
  }
  return { recordCurrentMicrosoftTeamsRoute };
}
