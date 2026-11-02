import { ne, notExists, or, sql } from "drizzle-orm";
import { chatEndpoints, chatGitHubConfigurations } from "@paperclipai/db";

// Only upgraded GitHub bots have the task-scoped response tools. Legacy
// connections retain automatic progress and final-answer publication.
export function allowsAutomaticRunPublication() {
  return or(ne(chatEndpoints.provider, "github"), notExists(
    sql`(select 1 from ${chatGitHubConfigurations}
      where ${chatGitHubConfigurations.companyId} = ${chatEndpoints.companyId}
        and ${chatGitHubConfigurations.endpointId} = ${chatEndpoints.id})`,
  ));
}

export function chatRunProjectionWindow(input: { since?: Date; limit?: number }) {
  return {
    since: input.since ?? new Date(Date.now() - 24 * 60 * 60_000),
    limit: Math.max(1, Math.min(input.limit ?? 200, 1_000)),
  };
}

export type ChatRunProjectionScope = { companyId: string; issueId?: string };
