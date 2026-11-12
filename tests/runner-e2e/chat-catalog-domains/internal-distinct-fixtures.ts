import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { type Entity, sameTask } from "./internal-support.js";

/** Same-title tasks are intentional context here, not repeated creation requests. */
export async function verifyDistinctTaskFixtures(ctx: ChatCatalogContext, expected: readonly Entity[]) {
  if (new Set(expected.map(row => row.id)).size !== expected.length) throw new Error("Distinct prerequisite tasks aliased to one public-create result");
  const saved = await Promise.all(expected.map(row => ctx.input.api.get<Entity>(`/api/issues/${row.id}`)));
  if (!saved.every((row, index) => row.companyId === ctx.input.fixtures.company.id && sameTask(expected[index]!, row)))
    throw new Error("Saved prerequisite task identity, title or project differs from the declared context");
  await ctx.input.evidence("chat-catalog-distinct-prerequisite-tasks.json", { companyId: ctx.input.fixtures.company.id,
    tasks: saved.map(row => ({ id: row.id, title: row.title, projectId: row.projectId, status: row.status, priority: row.priority })) });
  return saved;
}
