import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import type { IssueDocument } from "../../../packages/shared/src/types/issue.js";
import { uploadFactualQueryAttachment } from "../chat-query-attachments.js";
/** Actual selected-source facts, also delivered as a genuine human query file.
 * Conversation description persistence alone is not native wake delivery. */
export async function saveSkillConversationContext(ctx: ChatCatalogContext, input: { projectId?: string; description: string; document?: { key: string; title: string; body: string } }) {
  await ctx.input.api.post(`/api/companies/${ctx.input.fixtures.company.id}/chats/${ctx.input.fixtures.agent.id}`);
  await ctx.refreshIssue(); const source = ctx.issue();
  if (!source) throw new Error("Skill selection requires the actual standing conversation");
  await ctx.input.api.patch(`/api/issues/${source.id}`, { ...(input.projectId ? { projectId: input.projectId } : {}), description: input.description });
  if (input.document) {
    const { key, title, body } = input.document;
    const endpoint = `/api/issues/${source.id}/documents/${encodeURIComponent(key)}`;
    await ctx.input.api.putSensitive(endpoint, { title, body, format: "markdown", baseRevisionId: null });
    const saved = await ctx.input.api.get<IssueDocument>(endpoint);
    if (saved.issueId !== source.id || saved.body !== body) throw new Error("Skill input document did not persist on the canonical conversation");
  }
  const factualContextAttachment = await uploadFactualQueryAttachment(ctx, { filename: "skill-context.md",
    body: [input.description, ...(input.document ? [`# ${input.document.title}\n\n${input.document.body}`] : [])].join("\n\n") });
  return { ...source, factualContextAttachment };
}
