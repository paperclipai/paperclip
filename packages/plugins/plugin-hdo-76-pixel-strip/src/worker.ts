import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type {
  AgentRuntimeSnapshot,
  IssueRuntimeSnapshot,
  ProjectIssueIndex,
} from "./pixel-state.js";
import {
  buildPixelStrip,
  deriveSpriteStateForAgent,
  type PixelSpriteState,
} from "./pixel-state.js";

const PLUGIN_NAME = "hdo-76-pixel-strip";
const PLUGIN_HEALTH_MESSAGE =
  "HDO-76 pixel-strip prototype ready (read-only; no write-back; no timer inference)";

/**
 * Convert a raw `Issue` from `ctx.issues.list` into the persisted
 * snapshot this plugin needs. We deliberately drop every field that
 * is not required by the state derivation — the strip is a read-only
 * mirror of persisted state, not a general-purpose issue viewer.
 */
function toIssueSnapshot(
  issue: { id: string; status: string; assigneeAgentId?: string | null },
  hasActiveHeartbeat: boolean,
  pendingInteraction: "ask_user_questions" | "request_confirmation" | null,
): IssueRuntimeSnapshot {
  const status = (["todo", "in_progress", "in_review", "blocked", "done", "cancelled"].includes(
    issue.status,
  )
    ? issue.status
    : "todo") as IssueRuntimeSnapshot["status"];
  return {
    id: issue.id,
    status,
    assigneeAgentId: issue.assigneeAgentId ?? null,
    hasActiveHeartbeat,
    pendingInteraction,
  };
}

function toAgentSnapshot(agent: {
  id: string;
  displayName?: string | null;
  status?: string | null;
}): AgentRuntimeSnapshot {
  const heartbeatStatus = (["active", "idle", "paused", "errored"].includes(String(agent.status ?? ""))
    ? String(agent.status)
    : "idle") as AgentRuntimeSnapshot["heartbeatStatus"];
  return {
    id: agent.id,
    displayName: agent.displayName ?? agent.id,
    heartbeatStatus,
  };
}

/**
 * Build a per-project issue index from the persisted runtime. The
 * plugin never invents issues — every issue comes from `ctx.issues.list`.
 */
async function buildProjectIssueIndex(
  ctx: {
    issues: { list: (params: { projectId: string; companyId: string }) => Promise<unknown[]> };
  },
  projectId: string,
  companyId: string,
): Promise<ProjectIssueIndex> {
  const rawIssues = await ctx.issues.list({ projectId, companyId });
  const snapshots: IssueRuntimeSnapshot[] = [];
  for (const raw of rawIssues) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!id) continue;
    const status = typeof r.status === "string" ? r.status : "todo";
    const assigneeAgentId =
      typeof r.assigneeAgentId === "string"
        ? r.assigneeAgentId
        : r.assigneeAgentId === null
          ? null
          : null;
    // `hasActiveHeartbeat` and `pendingInteraction` are derived from
    // persisted fields only. We do not introduce a timer.
    const hasActiveHeartbeat =
      typeof r.activeHeartbeat === "boolean" ? r.activeHeartbeat : false;
    const pendingInteractionRaw =
      typeof r.pendingInteractionKind === "string" ? r.pendingInteractionKind : null;
    const pendingInteraction =
      pendingInteractionRaw === "ask_user_questions" ||
      pendingInteractionRaw === "request_confirmation"
        ? pendingInteractionRaw
        : null;
    snapshots.push(
      toIssueSnapshot(
        { id, status, assigneeAgentId },
        hasActiveHeartbeat,
        pendingInteraction,
      ),
    );
  }
  return { projectId, issues: snapshots };
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info(`${PLUGIN_NAME} plugin setup`);

    // Per-project pixel strip. State is mapped only from persisted
    // runtime state; no animation that implies work; no timer
    // inference; no write-back.
    ctx.data.register(
      "pixel-strip",
      async (params: Record<string, unknown>) => {
        const projectId = typeof params.projectId === "string" ? params.projectId : "";
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        if (!projectId || !companyId) return { sprites: [] };
        const [index, agentsRaw] = await Promise.all([
          buildProjectIssueIndex(ctx, projectId, companyId),
          ctx.agents.list({ companyId }),
        ]);
        const agents = agentsRaw
          .filter((a): a is { id: string; displayName?: string | null; status?: string | null } => {
            return typeof a === "object" && a !== null && typeof (a as { id?: unknown }).id === "string";
          })
          .map(toAgentSnapshot);
        return { sprites: buildPixelStrip(index, agents) };
      },
    );

    // Per-agent state lookup. Useful for the UI to render the
    // single-agent detail row without re-deriving it client-side.
    ctx.data.register(
      "pixel-strip-agent-state",
      async (params: Record<string, unknown>) => {
        const projectId = typeof params.projectId === "string" ? params.projectId : "";
        const companyId = typeof params.companyId === "string" ? params.companyId : "";
        const agentId = typeof params.agentId === "string" ? params.agentId : "";
        if (!projectId || !companyId || !agentId) return { state: "idle" as PixelSpriteState };
        const index = await buildProjectIssueIndex(ctx, projectId, companyId);
        return { state: deriveSpriteStateForAgent(index, agentId) };
      },
    );

    // Read the operator-controlled config so the UI can read
    // `showSidebarLink` from the canonical config store.
    ctx.data.register("plugin-config", async (params) => {
      const companyId =
        params && typeof params === "object" && "companyId" in params
          ? typeof (params as { companyId?: unknown }).companyId === "string"
            ? ((params as { companyId: string }).companyId)
            : ""
          : "";
      const config = companyId ? await ctx.config.get(companyId) : null;
      return {
        showSidebarLink: config?.showSidebarLink === true,
      };
    });

    // Refresh-on-event hooks. These handlers MUST NOT mutate any
    // persisted state; they are observed by the UI bridge and trigger
    // a `usePluginData("pixel-strip", …)` refresh.
    ctx.events.on("issue.updated", async () => {
      // intentionally empty: this handler exists so the host sees the
      // plugin as subscribed to live transitions; the UI re-fetches
      // `pixel-strip` on its own polling tick. We do not mutate state.
    });
    ctx.events.on("agent.run.started", async () => {
      // intentionally empty: see `issue.updated` above.
    });
    ctx.events.on("agent.run.finished", async () => {
      // intentionally empty: see `issue.updated` above.
    });
  },

  async onHealth() {
    return { status: "ok", message: PLUGIN_HEALTH_MESSAGE };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
