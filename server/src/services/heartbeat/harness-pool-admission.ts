import { harnessPoolEnvironmentScope } from "./harness-pool-environment.js";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agentTaskSessions, aiConnectionPools, aiConnectionTaskPins, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { BUILTIN_AI_FAILOVER_ROUTER_KEY, decodeHarnessPoolConfig, harnessPoolBindingSchema, type HarnessPoolExecutionSelection, type AiConnectionRouterSelection } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";
import { unprocessable } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";
import { aiConnectionRouterService, applyAiConnectionRouterTaskSettings } from "../ai-connection-router.js";
import { resolvePaperclipRunnerProviderProfile, type PaperclipRunnerProviderProfile } from "../native-runtime/provider-profile.js";
import { deriveTaskKeyWithHeartbeatFallback, shouldResetTaskSessionForWake } from "./run-state.js";

export type HarnessPoolAdmission = { kind: "selected"; selection: HarnessPoolExecutionSelection;
  routerSelection: AiConnectionRouterSelection; taskKey: string; profile: PaperclipRunnerProviderProfile };

export async function resolveHarnessPoolExecution(input: { db: Db; run: typeof heartbeatRuns.$inferSelect;
  agent: typeof agents.$inferSelect; userId: string | null }): Promise<HarnessPoolAdmission> {
  const { db, run, agent, userId } = input;
  const binding = harnessPoolBindingSchema.parse(agent.runtimeConfig.harnessPool);
  if (agent.adapterType !== "paperclip_runner" || !(await instanceSettingsService(db).getExperimental()).enableNativeRunner)
    throw unprocessable("Pool harness requires an enabled Paperclip Runner");
  if (!run.issueId || run.scopeKind !== "issue") throw unprocessable("Pool harness requires a task");
  if (agent.runtimeConfig.aiConnection || agent.adapterConfig.homeMode === "preconfigured")
    throw unprocessable("Pool harness owns its model account; remove conflicting connection settings");
  const [pool] = await db.select().from(aiConnectionPools).where(and(eq(aiConnectionPools.companyId, agent.companyId), eq(aiConnectionPools.id, binding.poolId)));
  if (!pool || pool.pluginKey !== BUILTIN_AI_FAILOVER_ROUTER_KEY || decodeHarnessPoolConfig(pool.config).kind !== "harness_pool")
    throw unprocessable("Choose an available harness pool");
  const context = parseObject(run.contextSnapshot);
  const taskKey = typeof context.aiRouterTaskKey === "string" && context.aiRouterTaskKey.trim() ? context.aiRouterTaskKey : deriveTaskKeyWithHeartbeatFallback(context, null) ?? run.issueId;
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, agent.companyId), eq(issues.id, run.issueId)));
  const [session] = await db.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, agent.companyId), eq(agentTaskSessions.agentId, agent.id),
    eq(agentTaskSessions.adapterType, "paperclip_runner"), eq(agentTaskSessions.taskKey, taskKey))).limit(1);
  const identity = session?.sessionParamsJson?.paperclipAiCredentialIdentity;
  const overrides = parseObject(parseObject(task?.assigneeAdapterOverrides).adapterConfig);
  const environmentId = await harnessPoolEnvironmentScope(db, agent, task);
  const routerSelection = await aiConnectionRouterService(db).resolve({ companyId: agent.companyId, agentId: agent.id, poolId: pool.id,
    adapterType: "paperclip_runner", environmentId, userId, taskKey, sourceAdapterConfig: { ...agent.adapterConfig, ...overrides }, overrides,
    existingGrantId: typeof identity === "string" ? identity.split(":")[0] : undefined,
    requireExisting: Boolean(session?.sessionDisplayId) && !shouldResetTaskSessionForWake(context), skipUsageProbe: true });
  const decoded = decodeHarnessPoolConfig(pool.config);
  if (decoded.kind !== "harness_pool") throw unprocessable("Invalid harness pool");
  const [pin] = await db.select().from(aiConnectionTaskPins).where(and(eq(aiConnectionTaskPins.companyId, agent.companyId),
    eq(aiConnectionTaskPins.poolId, pool.id), eq(aiConnectionTaskPins.agentId, agent.id), eq(aiConnectionTaskPins.taskKey, taskKey)));
  const pinned = pin?.member && decodeHarnessPoolConfig({ ...pool.config, members: [pin.member] });
  const memberSnapshot = pinned?.kind === "harness_pool" ? pinned.config.members[0] : undefined;
  if (!memberSnapshot) throw unprocessable("The selected pool member is unavailable");
  // A retained pin owns its historical model profile, including after pool edits.
  const profile = resolvePaperclipRunnerProviderProfile(applyAiConnectionRouterTaskSettings(agent.adapterConfig, routerSelection, "paperclip_runner"));
  if (routerSelection.binding.mode === "responsible_user") throw unprocessable("Pool members require an explicit account");
  const admittedMember = { ...memberSnapshot, connection: routerSelection.binding, model: String(routerSelection.runtimeConfig.model),
    effort: typeof routerSelection.runtimeConfig.modelReasoningEffort === "string" ? routerSelection.runtimeConfig.modelReasoningEffort
      : typeof routerSelection.runtimeConfig.reasoningEffort === "string" ? routerSelection.runtimeConfig.reasoningEffort : undefined };
  const selection: HarnessPoolExecutionSelection = { schemaVersion: 2, poolId: pool.id, poolRevision: pool.revision, poolName: decoded.config.name,
    memberId: routerSelection.memberId, memberSnapshot: admittedMember,
    fingerprint: createHash("sha256").update(JSON.stringify([routerSelection.binding, routerSelection.runtimeConfig, profile, routerSelection.runnerScope])).digest("hex") };
  return { kind: "selected", selection, routerSelection, taskKey, profile };
}
