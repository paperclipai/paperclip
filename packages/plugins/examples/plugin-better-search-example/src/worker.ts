import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { Issue, IssueComment } from "@paperclipai/shared";

const PLUGIN_NAME = "better-search-example";
const SEARCH_LIMIT = 30;

type AuthorType = "human" | "agent" | "unknown";

export type SearchResult = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: string;
  latestAuthorType: AuthorType;
};

function deriveAuthorType(issue: Issue, comments: IssueComment[]): AuthorType {
  if (comments.length > 0) {
    const latest = comments.reduce((a, b) =>
      new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b
    );
    if (latest.authorUserId) return "human";
    if (latest.authorAgentId) return "agent";
  }
  if (issue.createdByUserId) return "human";
  if (issue.createdByAgentId) return "agent";
  return "unknown";
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    ctx.data.register(
      "searchIssues",
      async (params: Record<string, unknown>) => {
        const companyId =
          typeof params.companyId === "string" ? params.companyId : "";
        const q = typeof params.q === "string" ? params.q.trim() : "";

        if (!companyId || !q) {
          return { results: [], query: q };
        }

        let issues: Issue[];
        try {
          // The SDK protocol omits `q`, but the underlying service accepts it.
          // Casting through unknown passes it through the RPC bridge unchanged.
          issues = await (
            ctx.issues.list as (p: unknown) => Promise<Issue[]>
          )({
            companyId,
            q,
            limit: SEARCH_LIMIT,
            offset: 0,
          });
        } catch (err) {
          ctx.logger.warn("Issue search failed", { q, error: String(err) });
          return { results: [], query: q, error: String(err) };
        }

        // Fetch latest comment for each result in parallel to determine author type.
        const results = await Promise.all(
          issues.map(async (issue): Promise<SearchResult> => {
            let comments: IssueComment[] = [];
            try {
              comments = await ctx.issues.listComments(issue.id, companyId);
            } catch {
              // Fallback to issue creator if comment fetch fails.
            }
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              status: issue.status,
              priority: issue.priority,
              assigneeAgentId: issue.assigneeAgentId,
              assigneeUserId: issue.assigneeUserId,
              createdAt:
                issue.createdAt instanceof Date
                  ? issue.createdAt.toISOString()
                  : String(issue.createdAt),
              latestAuthorType: deriveAuthorType(issue, comments),
            };
          })
        );

        return { results, query: q };
      }
    );
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
