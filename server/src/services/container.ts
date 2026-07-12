import type { Db } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { heartbeatService } from "./heartbeat.js";
import { instanceSettingsService } from "./instance-settings.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";
import { secretService } from "./secrets.js";
import { workTimelineService } from "./work-timeline.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export interface ServiceContainer {
  readonly agents: ReturnType<typeof agentService>;
  readonly heartbeat: ReturnType<typeof heartbeatService>;
  readonly instanceSettings: ReturnType<typeof instanceSettingsService>;
  readonly issueRecoveryActions: ReturnType<typeof issueRecoveryActionService>;
  readonly issues: ReturnType<typeof issueService>;
  readonly issueThreadInteractions: ReturnType<typeof issueThreadInteractionService>;
  readonly projects: ReturnType<typeof projectService>;
  readonly routines: ReturnType<typeof routineService>;
  readonly secrets: ReturnType<typeof secretService>;
  readonly workTimeline: ReturnType<typeof workTimelineService>;
}

/**
 * Composition root for server services.
 *
 * Service factories are closures that allocate their full method set on every
 * call; before this container each consumer (route module, scheduler,
 * sibling service) built private instances. Constructing the container once
 * per process and threading it through route/factory options gives every
 * consumer the same instance, preserving factory-scope state (e.g. the
 * issue-recovery-actions upsert queue) and avoiding duplicate construction.
 *
 * Getters are lazy and memoized: services a given process never touches are
 * never built, and construction order cannot create cycles.
 */
export function createServiceContainer(
  db: Db,
  opts: { pluginWorkerManager?: PluginWorkerManager } = {},
): ServiceContainer {
  const memo = new Map<string, unknown>();
  const lazy = <T>(key: string, build: () => T): T => {
    if (!memo.has(key)) memo.set(key, build());
    return memo.get(key) as T;
  };

  const container: ServiceContainer = {
    get agents() {
      return lazy("agents", () => agentService(db));
    },
    get heartbeat() {
      return lazy("heartbeat", () =>
        heartbeatService(db, { pluginWorkerManager: opts.pluginWorkerManager }));
    },
    get instanceSettings() {
      return lazy("instanceSettings", () => instanceSettingsService(db));
    },
    get issueRecoveryActions() {
      return lazy("issueRecoveryActions", () => issueRecoveryActionService(db));
    },
    get issues() {
      return lazy("issues", () => issueService(db));
    },
    get issueThreadInteractions() {
      return lazy("issueThreadInteractions", () => issueThreadInteractionService(db));
    },
    get projects() {
      return lazy("projects", () => projectService(db));
    },
    get routines() {
      return lazy("routines", () =>
        routineService(db, {
          pluginWorkerManager: opts.pluginWorkerManager,
          heartbeat: container.heartbeat,
        }));
    },
    get secrets() {
      return lazy("secrets", () => secretService(db));
    },
    get workTimeline() {
      return lazy("workTimeline", () => workTimelineService(db));
    },
  };

  return container;
}
