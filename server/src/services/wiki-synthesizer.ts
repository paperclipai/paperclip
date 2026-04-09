import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { logger } from "../middleware/logger.js";

const WIKI_SYNTHESIS_PROMPT = `## Wiki Update Task

You are now in a post-task wiki update phase. Your goal is to review what you just accomplished and update your personal wiki with any durable knowledge worth preserving.

Your wiki is a long-term memory that persists across all future tasks. Use the wiki tools available to you:
- paperclipWikiListPages — see all existing wiki pages
- paperclipWikiReadPage — read a specific page
- paperclipWikiWritePage — write/update a page
- paperclipWikiDeletePage — remove an outdated page

### What to capture:
- Cross-cutting learnings, patterns, conventions, gotchas → learnings.md
- Project-specific knowledge → projects/<project-slug>.md
- Deep-dive reference material → topics/<topic-name>.md
- Update the index if you create new pages

### Guidelines:
- Only persist genuinely durable knowledge, not transient task status
- When updating existing pages, preserve all still-valid content and merge in new learnings
- Keep pages focused and factual
- If you learned nothing new worth persisting, just respond that no updates are needed

Start by listing your current wiki pages, then decide what to update.`;

const WIKI_SYNTHESIS_TIMEOUT_MS = 90_000;

export async function runWikiSynthesis(opts: {
  adapter: ServerAdapterModule;
  runId: string;
  agent: { id: string; companyId: string; name: string; [key: string]: unknown };
  sessionId: string;
  sessionParams: Record<string, unknown> | null;
  sessionDisplayId: string | null;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}): Promise<{ completed: boolean; error?: string }> {
  const { adapter, runId, agent, config, context } = opts;

  const wikiConfig: Record<string, unknown> = {
    ...config,
    promptTemplate: WIKI_SYNTHESIS_PROMPT,
    bootstrapPromptTemplate: "",
    paperclipAgentWiki: undefined, // already in session context
    maxTurnsPerRun: 5, // bound tool-use loops
  };

  const wikiContext: Record<string, unknown> = {
    ...context,
    paperclipWake: undefined, // no wake payload
    paperclipSessionHandoffMarkdown: undefined,
  };

  const wikiRuntime = {
    sessionId: opts.sessionId,
    sessionParams: opts.sessionParams,
    sessionDisplayId: opts.sessionDisplayId,
    taskKey: null,
  };

  try {
    const result = await Promise.race([
      adapter.execute({
        runId: `${runId}-wiki`,
        agent: agent as any,
        runtime: wikiRuntime,
        config: wikiConfig,
        context: wikiContext,
        onLog: async () => {}, // silent — wiki synthesis logs not needed
        authToken: opts.authToken,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("wiki synthesis timed out")), WIKI_SYNTHESIS_TIMEOUT_MS),
      ),
    ]);

    if (result.timedOut) {
      return { completed: false, error: "wiki synthesis timed out" };
    }
    if ((result.exitCode ?? 0) !== 0) {
      return { completed: false, error: result.errorMessage ?? "wiki synthesis failed" };
    }
    return { completed: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, runId }, "wiki synthesis execution error");
    return { completed: false, error: message };
  }
}
