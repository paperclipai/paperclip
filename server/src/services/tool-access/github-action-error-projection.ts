import { and, eq, inArray, or, sql } from "drizzle-orm";
import { toolConnections, type Db } from "@paperclipai/db";
import type { IssueThreadInteraction, RequestConfirmationInteraction } from "@paperclipai/shared";
import { projectGitHubActionResult } from "./github-access-errors.js";

/** Read-only enrichment of historical errors. Resolve provider identity in one
 * company-scoped batch without reading credentials or relying on mutable names. */
export async function projectGitHubInteractionErrors(
  db: Pick<Db, "select">,
  interactions: IssueThreadInteraction[],
): Promise<IssueThreadInteraction[]> {
  const candidates = interactions.filter((interaction): interaction is RequestConfirmationInteraction =>
    interaction.kind === "request_confirmation"
    && Boolean(interaction.payload.toolAction?.connectionId)
    && projectGitHubActionResult("github", interaction.result) !== interaction.result,
  );
  if (candidates.length === 0) return interactions;

  const connections = await db.select({
    id: toolConnections.id,
    companyId: toolConnections.companyId,
    applicationId: toolConnections.applicationId,
  }).from(toolConnections).where(and(
    inArray(toolConnections.id, [...new Set(candidates.map(item => item.payload.toolAction!.connectionId!))]),
    inArray(toolConnections.companyId, [...new Set(candidates.map(item => item.companyId))]),
    or(
      eq(sql<string>`${toolConnections.config}->>'sourceTemplateKey'`, "github"),
      eq(sql<string>`${toolConnections.transportConfig}->>'sourceTemplateKey'`, "github"),
    ),
  ));
  const byCompanyAndId = new Map(connections.map(connection => [`${connection.companyId}:${connection.id}`, connection]));
  const projected = new Map(candidates.flatMap(interaction => {
    const action = interaction.payload.toolAction!;
    const connection = byCompanyAndId.get(`${interaction.companyId}:${action.connectionId}`);
    if (!connection || (action.applicationId && action.applicationId !== connection.applicationId)) return [];
    return [[interaction.id, {
      ...interaction, result: projectGitHubActionResult("github", interaction.result),
    }] as const];
  }));
  return interactions.map(interaction => projected.get(interaction.id) ?? interaction);
}
