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

export type Preset = {
  id: string;
  name: string;
  query: string;
  filters: Record<string, unknown>;
};

// Presets are stored per user, scoped to the company, so one user's presets
// never leak to another. The userId is used as stateKey within the "presets"
// namespace — the narrowest available scope given the SDK's scope kinds.
function presetsStateKey(companyId: string, userId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: "presets",
    stateKey: userId,
  };
}

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

    // -------------------------------------------------------------------------
    // Search issues
    // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // Presets — read
    // -------------------------------------------------------------------------

    ctx.data.register(
      "getPresets",
      async (params: Record<string, unknown>) => {
        const companyId =
          typeof params.companyId === "string" ? params.companyId : "";
        const userId =
          typeof params.userId === "string" ? params.userId : "";

        if (!companyId || !userId) {
          return { presets: [] as Preset[] };
        }

        const stored = await ctx.state.get(presetsStateKey(companyId, userId));
        return { presets: Array.isArray(stored) ? (stored as Preset[]) : [] };
      }
    );

    // -------------------------------------------------------------------------
    // Presets — write (create or update, preserving position on rename)
    // -------------------------------------------------------------------------

    ctx.actions.register(
      "savePreset",
      async (params: Record<string, unknown>) => {
        const companyId =
          typeof params.companyId === "string" ? params.companyId : "";
        const userId =
          typeof params.userId === "string" ? params.userId : "";
        const preset = params.preset as Preset | undefined;

        if (!companyId || !userId || !preset?.id) {
          throw new Error("savePreset: missing companyId, userId, or preset");
        }

        const key = presetsStateKey(companyId, userId);
        const stored = await ctx.state.get(key);
        const presets: Preset[] = Array.isArray(stored)
          ? (stored as Preset[])
          : [];

        const idx = presets.findIndex((p) => p.id === preset.id);
        if (idx >= 0) {
          // Update in place to preserve row position (e.g. rename).
          presets[idx] = preset;
        } else {
          presets.push(preset);
        }

        await ctx.state.set(key, presets);
        ctx.logger.info(`savePreset: upserted "${preset.name}"`, { userId });
        return { presets };
      }
    );

    // -------------------------------------------------------------------------
    // Presets — delete
    // -------------------------------------------------------------------------

    ctx.actions.register(
      "deletePreset",
      async (params: Record<string, unknown>) => {
        const companyId =
          typeof params.companyId === "string" ? params.companyId : "";
        const userId =
          typeof params.userId === "string" ? params.userId : "";
        const presetId =
          typeof params.presetId === "string" ? params.presetId : "";

        if (!companyId || !userId || !presetId) {
          throw new Error("deletePreset: missing companyId, userId, or presetId");
        }

        const key = presetsStateKey(companyId, userId);
        const stored = await ctx.state.get(key);
        const presets: Preset[] = Array.isArray(stored)
          ? (stored as Preset[])
          : [];

        await ctx.state.set(
          key,
          presets.filter((p) => p.id !== presetId)
        );
        ctx.logger.info(`deletePreset: removed "${presetId}"`, { userId });
        return { deleted: presetId };
      }
    );
  },

  async onHealth() {
    return { status: "ok", message: `${PLUGIN_NAME} ready` };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
