import { FixtureRegistry } from "../fixture-registry.js";
import { JourneyError, type JourneyContext, type PreparedBacklogTask, type TargetSession } from "./types.js";

/** One registry per campaign: an onboarding receipt may satisfy later prerequisites. */
export function journeyFixtures(session: TargetSession, campaignId?: string) {
  let ready: JourneyContext | undefined;
  let preparation: Promise<JourneyContext> | undefined;
  let backlogTask: Promise<PreparedBacklogTask> | undefined;
  let taskCompanyId: string | undefined;
  const registry = new FixtureRegistry().register({
    id: "ready-context",
    async setup() { return ready ??= await (preparation ??= session.prepare()); },
  });
  for (const id of ["company", "board-user", "task-write", "agent", "skill-write", "review-service"]) registry.register({
    id, dependencies: ["ready-context"],
    async setup(resolved) {
      const context = resolved.get("ready-context") as JourneyContext;
      if (!context.capabilities.includes(id)) throw new JourneyError("unsupported", `missing_${id}`);
      return context;
    },
  });
  registry.register({
    id: "backlog-task", dependencies: ["company", "board-user", "task-write"],
    async setup(resolved) {
      if (!campaignId?.trim()) throw new JourneyError("blocked", "campaign_id_required_for_backlog_task");
      const context = resolved.get("ready-context") as JourneyContext;
      if (backlogTask && taskCompanyId !== context.company.id) throw new JourneyError("failed", "backlog_task_company_changed");
      taskCompanyId = context.company.id;
      backlogTask ??= (async () => {
        const title = `Journey QA ${campaignId}`;
        await session.own({ kind: "issue", name: title });
        const issue = await context.api.post<{ id: string; identifier: string }>(`/api/companies/${context.company.id}/issues`, {
          title, description: "Disposable task-property verification", status: "backlog",
        });
        if (typeof issue?.id !== "string" || !issue.id) throw new JourneyError("failed", "invalid_backlog_task_receipt");
        await session.own({ kind: "issue", name: title, id: issue.id });
        if (typeof issue.identifier !== "string" || !issue.identifier) throw new JourneyError("failed", "invalid_backlog_task_receipt");
        return { id: issue.id, title, identifier: issue.identifier };
      })();
      context.fixtures = { ...context.fixtures, backlogTask: await backlogTask };
      return context.fixtures.backlogTask;
    },
  });
  return {
    provide(context: JourneyContext) { ready = context; },
    async resolve(required: readonly string[]) {
      if (required.includes("backlog-task") && !campaignId?.trim()) throw new JourneyError("blocked", "campaign_id_required_for_backlog_task");
      const fixtures = await registry.setupAll(required);
      return fixtures.values.get("ready-context") as JourneyContext;
    },
  };
}
