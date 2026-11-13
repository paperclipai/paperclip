import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { chatEndpoints, chatSdkState, toolConnections, type Db } from "@paperclipai/db";
import type { ChatEndpointSetupState, ToolCredentialSecretRef } from "@paperclipai/shared";
import { GITHUB_RECOVERY_STATE_KEY, githubRecoveryWindow } from "./webhook-recovery-state.js";
import type { GitHubWebhookRecoveryScope } from "./webhook-recovery-notifications.js";

export type GitHubWebhookRecoveryDeadline = { id: string; companyId: string; connectionId: string; dueAt: number };

export function githubWebhookRecoverySchedule(db: Db, options: {
  runtimeGeneration(setup: ChatEndpointSetupState): number;
  credentialFingerprint(refs: ToolCredentialSecretRef[]): string;
  getWebhookPublicBaseUrl(): string | null;
  recover(endpointId: string, canRun: () => boolean, signal?: AbortSignal): Promise<void>;
}) {
  async function load(scope: GitHubWebhookRecoveryScope | undefined, canRun: () => boolean, signal?: AbortSignal) {
    const entries: GitHubWebhookRecoveryDeadline[] = [];
    const baseUrl = options.getWebhookPublicBaseUrl();
    if (!baseUrl?.startsWith("https://")) return entries;
    let cursor: string | undefined;
    while (canRun() && !signal?.aborted) {
      const rows = await db.select({ endpoint: chatEndpoints, refs: toolConnections.credentialSecretRefs,
        window: chatSdkState.value }).from(chatEndpoints).innerJoin(toolConnections, and(
        eq(toolConnections.id, chatEndpoints.connectionId), eq(toolConnections.companyId, chatEndpoints.companyId),
      )).leftJoin(chatSdkState, and(eq(chatSdkState.endpointId, chatEndpoints.id),
        eq(chatSdkState.stateKey, GITHUB_RECOVERY_STATE_KEY))).where(and(
        eq(chatEndpoints.provider, "github"), eq(chatEndpoints.status, "active"),
        isNotNull(chatEndpoints.botExternalId), sql`${chatEndpoints.botExternalId} <> ''`,
        sql`nullif(${chatEndpoints.setup}#>>'{github,cloudRegistrationId}', '') is null`,
        eq(toolConnections.enabled, true), eq(toolConnections.status, "active"),
        scope?.kind === "endpoint" ? eq(chatEndpoints.id, scope.id) : undefined,
        scope?.kind === "connection" ? eq(chatEndpoints.connectionId, scope.id) : undefined,
        scope?.kind === "company" ? eq(chatEndpoints.companyId, scope.id) : undefined,
        cursor ? gt(chatEndpoints.id, cursor) : undefined,
      )).orderBy(asc(chatEndpoints.id)).limit(100);
      for (const { endpoint, refs, window } of rows) {
        const previous = githubRecoveryWindow(window);
        const matches = previous && previous.generation === options.runtimeGeneration(endpoint.setup) &&
          previous.credentialFingerprint === options.credentialFingerprint(refs) &&
          previous.appId === endpoint.botExternalId &&
          previous.webhookUrl === `${baseUrl}/api/chat-webhooks/${endpoint.publicId}/github`;
        entries.push({ id: endpoint.id, companyId: endpoint.companyId, connectionId: endpoint.connectionId,
          dueAt: matches ? Date.parse(previous.nextScanAt) : 0 });
      }
      if (rows.length < 100) return entries;
      cursor = rows[rows.length - 1].endpoint.id;
    }
    throw signal?.reason ?? new Error("GitHub webhook recovery reconstruction stopped");
  }
  async function check(id: string, canRun: () => boolean, signal?: AbortSignal) {
    const scope = { kind: "endpoint", id } as const;
    const [before] = await load(scope, canRun, signal);
    if (!before || before.dueAt > Date.now()) return before ?? null;
    if (!canRun() || signal?.aborted) return before;
    await options.recover(id, canRun, signal);
    const [after] = await load(scope, canRun, signal);
    return after ?? null;
  }
  return { load, check };
}
