import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { CHAT_OPENCODE_MODEL, CHAT_OPENCODE_PROFILE } from "../chat-runtime-profile.js";
import type { SecretReference } from "../types.js";
import {
  prepareTeamConditions,
  observeTeamConditions,
  gradeTeamConditions,
} from "./external-team-conditional.js";
import { expect } from "@playwright/test";
import type { Agent, AgentDetail } from "../../../packages/shared/src/types/agent.js";
import type {
  CatalogTeam,
  CatalogTeamImportPreviewResult,
  InstalledCatalogTeam,
} from "../../../packages/shared/src/types/teams-catalog.js";
import { sendChatMessage } from "../chat-flow.js";
import {
  definition,
  externalObservation,
  observeExternal,
  root,
  checks,
  verifyRenderedReply,
} from "./external-support.js";
import { remainingIdentityObservationBudget, waitForReply } from "./identity-support.js";
import type { Entity } from "./internal-support.js";
interface Resource {
  id: string;
  companyId: string;
  name?: string;
  status?: string;
  urlKey?: string;
}
export interface TeamResourceSnapshot {
  agents: Agent[];
  projects: Resource[];
  routines: Resource[];
  installed: InstalledCatalogTeam[];
}
export function catalogTeamProvenance(agent: Agent) {
  return (
    agent.metadata as {
      paperclip?: {
        catalogTeam?: {
          catalogId?: string;
          originHash?: string;
          agentSlug?: string;
        };
      };
    } | null
  )?.paperclip?.catalogTeam;
}
export function catalogTeamMembers(
  snapshot: TeamResourceSnapshot,
  teamId: string,
) {
  return snapshot.agents.filter(
    (agent) => catalogTeamProvenance(agent)?.catalogId === teamId,
  );
}
interface TeamInstallRuntime {
  profileId: string; adapterType: "paperclip_runner"; provider: "opencode"; model: string; accountRef: SecretReference;
}
export function selectedTeamInstallRuntime(ctx: ChatCatalogContext, actor: Agent) {
  const profile = ctx.input.execution.profile, config = actor.adapterConfig;
  const ref = ctx.input.fixtures.secretRefs.OPENROUTER_API_KEY;
  const bound = (config.env as Record<string, unknown> | undefined)?.OPENROUTER_API_KEY as SecretReference | undefined;
  if (profile.id !== CHAT_OPENCODE_PROFILE || profile.provider !== "opencode" || profile.model !== CHAT_OPENCODE_MODEL || profile.credential !== "OPENROUTER_API_KEY"
    || actor.companyId !== ctx.input.fixtures.company.id || actor.adapterType !== "paperclip_runner" || config.provider !== "opencode" || config.model !== CHAT_OPENCODE_MODEL || config.timeoutSec !== 0
    || !ref || ref.type !== "secret_ref" || !ref.secretId || ref.version !== "latest" || Object.keys(ref).sort().join() !== "secretId,type,version"
    || bound?.type !== ref.type || bound.secretId !== ref.secretId || bound.version !== ref.version)
    throw new Error("Selected team installer must use its actual configured OpenCode OpenRouter1017 account");
  return { profileId: profile.id, adapterType: "paperclip_runner", provider: "opencode", model: profile.model, accountRef: { type: ref.type, secretId: ref.secretId, version: ref.version } } as TeamInstallRuntime;
}
export function teamInstallOverrides(team: Pick<CatalogTeam, "agentSlugs">, runtime: TeamInstallRuntime) {
  return Object.fromEntries(team.agentSlugs.map(slug => [slug, { adapterType: runtime.adapterType, adapterConfig: { provider: runtime.provider, model: runtime.model, timeoutSec: 0, lifecycleMode: "per_turn", opencodePermissionMode: "allow", env: { OPENROUTER_API_KEY: runtime.accountRef } } }]));
}
export function teamMemberRuntimeMatches(agent: Agent, expected: TeamInstallRuntime, companyId: string) {
  const config = agent.adapterConfig, ref = (config?.env as Record<string, unknown> | undefined)?.OPENROUTER_API_KEY as SecretReference | undefined;
  return expected?.profileId === CHAT_OPENCODE_PROFILE && expected.adapterType === "paperclip_runner" && expected.provider === "opencode" && expected.model === CHAT_OPENCODE_MODEL
    && expected.accountRef?.type === "secret_ref" && !!expected.accountRef.secretId && expected.accountRef.version === "latest"
    && agent.companyId === companyId && agent.adapterType === expected.adapterType && config?.provider === expected.provider && config.model === expected.model && config.timeoutSec === 0
    && ref?.type === "secret_ref" && ref.secretId === expected.accountRef.secretId && ref.version === "latest";
}
export async function verifyInstalledTeamRuntime(ctx: ChatCatalogContext, team: CatalogTeam, first: TeamResourceSnapshot, runtime: TeamInstallRuntime) {
  const members = catalogTeamMembers(first, team.id);
  if (members.length !== team.agentSlugs.length) throw new Error("Installed team runtime readback requires the complete actual package");
  const saved = await Promise.all(members.map(member => ctx.input.api.get<Agent>(`/api/agents/${member.id}`)));
  if (JSON.stringify(ids(saved)) !== JSON.stringify(ids(members)) || saved.some(member => !teamMemberRuntimeMatches(member, runtime, ctx.input.fixtures.company.id))) throw new Error("Actual saved installed-member runtime differs from selected OpenCode1017");
  const memberIds = new Set(members.map(member => member.id));
  if ((await ctx.allRuns()).some(run => memberIds.has(run.agentId) && !!run.startedAt)) throw new Error("Imported member work started before independent runtime readback");
  return { memberIds: saved.map(member => member.id).sort(), provider: runtime.provider, model: runtime.model, verifiedBeforeImportedWork: true };
}
const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();
function hasResourceLink(
  links: string[],
  origin: string,
  prefix: unknown,
  kind: "agents" | "projects",
  resource: { id: string; urlKey?: string },
) {
  return links.some((href) => {
    try {
      const url = new URL(href, origin),
        parts = url.pathname.split("/");
      const index = parts.indexOf(kind),
        ref = parts[index + 1];
      return (
        url.origin === origin &&
        index === 2 &&
        decodeURIComponent(parts[1]!) === prefix &&
        !!ref &&
        [resource.id, resource.urlKey].includes(ref)
      );
    } catch {
      return false;
    }
  });
}
export async function observeTeamResources(
  ctx: import("../chat-catalog-contract.js").ChatCatalogContext,
): Promise<TeamResourceSnapshot> {
  const [agents, projects, routines, installed] = await Promise.all([
    ctx.input.api.get<Agent[]>(`${root(ctx)}/agents`),
    ctx.input.api.get<Resource[]>(`${root(ctx)}/projects`),
    ctx.input.api.get<Resource[]>(`${root(ctx)}/routines`),
    ctx.input.api.get<InstalledCatalogTeam[]>(
      `${root(ctx)}/teams/catalog/installed`,
    ),
  ]);
  return { agents, projects, routines, installed };
}
export function gradeTeamInstall(value: unknown) {
  const c = checks(),
    o = externalObservation(value);
  c.add(
    "complete-team-install-evidence",
    !!o,
    "Accepted immutable preview, effective creator authority, attributed public installation and repeat reconciliation are required.",
  );
  if (!o) return c.result();
  const team = o.state.team as CatalogTeam | undefined,
    first = o.state.first as TeamResourceSnapshot | undefined,
    after = o.state.after as TeamResourceSnapshot | undefined,
    before = o.state.before as TeamResourceSnapshot | undefined;
  c.add(
    "accepted-supported-preview-and-authority",
    !!team &&
      o.state.previewAccepted === true &&
      o.state.previewErrorCount === 0 &&
      o.state.actorCanCreateAgents === true &&
      o.state.existingAccountReady === true,
    "The exact real catalog preview is accepted and the acting CEO has actual installation/resource authority with a ready existing runtime account.",
  );
  const members = team && after ? catalogTeamMembers(after, team.id) : [];
  c.add(
    "intended-agent-resources-once",
    !!team &&
      !!after &&
      !!before &&
      members.length === team.agentSlugs.length &&
      members.every(
        (agent) =>
          agent.companyId === o.companyId &&
          catalogTeamProvenance(agent)?.originHash === team.contentHash,
      ) &&
      new Set(members.map((agent) => agent.urlKey)).size === members.length &&
      after.agents.length - before.agents.length === team.counts.agents,
    "Exactly the package's agents exist in this company with immutable catalog provenance; no unrelated or duplicate hires satisfy the count.",
  );
  const runtime = o.state.selectedRuntime as TeamInstallRuntime, runtimeReadback = o.state.runtimeReadback as { memberIds?: string[]; provider?: string; model?: string; verifiedBeforeImportedWork?: boolean } | undefined;
  c.add("selected-runtime-preserved-for-every-installed-member", !!runtime && !!first && !!after && !!team
    && runtimeReadback?.verifiedBeforeImportedWork === true && runtimeReadback.provider === runtime.provider && runtimeReadback.model === runtime.model && JSON.stringify(runtimeReadback.memberIds) === JSON.stringify(ids(members))
    && catalogTeamMembers(first, team.id).length === team.agentSlugs.length && catalogTeamMembers(first, team.id).every(member => teamMemberRuntimeMatches(member, runtime, o.companyId))
    && members.every(member => teamMemberRuntimeMatches(member, runtime, o.companyId)),
  "Every actual imported member retains the selected OpenCode/OpenRouter1017 and exact existing company account reference; public saved configuration is independently read before any imported work.");
  c.add(
    "intended-project-and-routine-resources",
    !!team &&
      !!after &&
      !!before &&
      after.projects.length - before.projects.length === team.counts.projects &&
      after.routines.length - before.routines.length === team.counts.routines &&
      after.projects.every((project) => project.companyId === o.companyId) &&
      after.installed.some(
        (row) =>
          row.catalogId === team.id &&
          row.agentCount === team.counts.agents &&
          !row.outOfDate,
      ),
    "Actual project/routine deltas and the server-computed installed-team state agree with the preview in the active company.",
  );
  c.add(
    "actual-agent-installation-attribution",
    !!team &&
      o.activity.some(
        (row) =>
          row.action === "company.team_catalog_installed" &&
          row.actorType === "agent" &&
          row.agentId === o.leadId,
      ),
    "The requested installer operation is independently attributed to the actual model actor, rather than performed as an oracle setup side effect.",
  );
  c.add(
    "uncertain-repeat-reconciles-identities",
    !!team &&
      !!first &&
      !!after &&
      first.installed.some((row) => row.catalogId === team.id) &&
      JSON.stringify(ids(first.agents)) === JSON.stringify(ids(after.agents)) &&
      JSON.stringify(ids(first.projects)) ===
        JSON.stringify(ids(after.projects)) &&
      JSON.stringify(ids(first.routines)) ===
        JSON.stringify(ids(after.routines)) &&
      o.state.repeatHumanQuery === o.state.originalHumanQuery,
    "The actual repeated canonical request preserves existing agent/project/routine identities rather than blindly installing renamed copies.",
  );
  const second = o.phaseReplies.filter(
    (reply) => reply.runId !== o.state.initialRunId,
  );
  c.add(
    "phase-bound-reconciliation-reply",
    second.some((reply) =>
      o.runs.some(
        (run) => run.id === reply.runId && run.status === "succeeded",
      ),
    ) &&
      /already|existing|installed|same|reconcil/i.test(
        second.map((reply) => reply.body).join("\n"),
      ),
    "The repeat outcome belongs to its own real persisted model continuation.",
  );
  c.add(
    "actual-installed-resource-links",
    members.length > 0 &&
      members.every((agent) =>
        hasResourceLink(
          o.links,
          o.origin,
          o.state.companyPrefix,
          "agents",
          agent,
        ),
      ) &&
      !!after &&
      !!before &&
      after.projects
        .filter(
          (project) => !before.projects.some((old) => old.id === project.id),
        )
        .every((project) =>
          hasResourceLink(
            o.links,
            o.origin,
            o.state.companyPrefix,
            "projects",
            project,
          ),
        ),
    "The response links the actual installed members and project, not just the catalog or an intended future installation.",
  );
  for (const check of gradeTeamConditions(o).checks)
    c.add(check.id, check.passed, check.detail);
  return c.result();
}
export const teamInstallExternalCases = [
  definition(
    "teams.install-team",
    async (ctx) => {
      const teams =
        await ctx.input.api.get<CatalogTeam[]>("/api/teams/catalog");
      const team = teams.find(
        (row) =>
          row.slug === "product-engineering" &&
          row.compatibility === "compatible",
      );
      if (!team)
        throw new Error(
          "Setup blocker: real compatible Product Engineering team catalog package is unavailable",
        );
      const beforePermissions = await ctx.input.api.get<AgentDetail>(`/api/agents/${ctx.input.fixtures.agent.id}`);
      if (beforePermissions.id !== ctx.input.fixtures.agent.id || beforePermissions.companyId !== ctx.input.fixtures.company.id || beforePermissions.role !== "ceo" || typeof beforePermissions.access?.canAssignTasks !== "boolean") throw new Error("Team fixture requires the independently observed installer identity and assignment authority");
      await ctx.input.api.patch(
        `/api/agents/${ctx.input.fixtures.agent.id}/permissions`,
        { canCreateAgents: true, canAssignTasks: beforePermissions.access.canAssignTasks },
      );
      await ctx.input.api.patch(root(ctx), {
        requireBoardApprovalForNewAgents: false,
      });
      const actor = await ctx.input.api.get<AgentDetail>(
        `/api/agents/${ctx.input.fixtures.agent.id}`,
      );
      if (
        actor.lifecycleState !== "ready" ||
        actor.permissions?.canCreateAgents !== true ||
        actor.access?.canAssignTasks !== beforePermissions.access.canAssignTasks
      )
        throw new Error(
          "Setup blocker: actual selected installer actor lacks a ready account or creation authority",
        );
      const selectedRuntime = selectedTeamInstallRuntime(ctx, actor);
      const adapterOverrides = teamInstallOverrides(team, selectedRuntime);
      const conditional = await prepareTeamConditions(ctx, team);
      const preview = conditional.conditionalPreview;
      if (preview.errors.length || preview.portabilityPreview.errors.length)
        throw new Error(
          "Setup blocker: accepted team fixture preview has real preparation conflicts",
        );
      const before = await observeTeamResources(ctx);
      if (catalogTeamMembers(before, team.id).length)
        throw new Error(
          "Setup blocker: the selected team is already installed in this disposable company",
        );
      await ctx.input.api.post(`${root(ctx)}/chats/${actor.id}`);
      await ctx.refreshIssue();
      await ctx.input.api.patch(`/api/issues/${ctx.issue()!.id}`, {
        description: `The accepted website team preview is ${team.name}, catalog key ${team.key}, content hash ${team.contentHash}. Install the complete selected package under the current CEO using this company's existing eligible runtime account. No team resource is installed yet. The selected runtime uses ${actor.adapterType} in environment ${ctx.input.fixtures.environment.id}. The existing eligible runtime is OpenCode/OpenRouter ${selectedRuntime.model}; its credential stays in the existing same-company secret reference. The supported installer takes these per-slug adapterOverrides for this accepted runtime selection: ${JSON.stringify(adapterOverrides)}.`,
      });
      const session = await ctx.input.api.get<{ user: { id: string } }>("/api/auth/get-session");
      if (!session.user?.id) throw new Error("Team installer requires its actual responsible human session");
      return {
        sourceIssueId: ctx.issue()!.id,
        humanId: session.user.id,
        ...conditional,
        selectedRuntime,
        team,
        before,
        companyPrefix: ctx.input.fixtures.company.issuePrefix,
        previewAccepted: true,
        previewErrorCount:
          preview.errors.length + preview.portabilityPreview.errors.length,
        actorCanCreateAgents: actor.permissions?.canCreateAgents === true,
        existingAccountReady: actor.lifecycleState === "ready",
        originalHumanQuery: ctx.scenario.query,
      };
    },
    gradeTeamInstall,
    {
      authentication: "human-session",
      oracleVersion: "paperclip.chat-catalog.team-install.v3",
      expectedRunCount: 2,
      expectedHumanMessageCount: 2,
      attemptTimeoutMs: 480_000,
      sourceFiles: [
        "chat-catalog-domains/external-team-install.ts",
        "chat-catalog-domains/external-team-conditional.ts",
        "../../server/src/services/teams-catalog.ts",
        "../../server/src/services/company-skills.ts",
        "../../server/src/services/company-portability.ts",
        "../../packages/teams-catalog/generated/catalog.json",
        "chat-catalog-domains/external-support.ts",
        "chat-catalog-domains/internal-support.ts",
        "chat-catalog-domains/identity-support.ts",
        "chat-flow.ts",
        "chat-scenarios/teams.yaml",
      ],
      async act(ctx, state) {
        const remaining = () => remainingIdentityObservationBudget(ctx);
        remaining(); await waitForReply(ctx, ctx.observationDeadlineAt); remaining();
        const source = ctx.issue();
        if (!source || source.id !== state.sourceIssueId || source.companyId !== ctx.input.fixtures.company.id)
          throw new Error("Team install initial response has the wrong conversation source");
        const [runs, comments] = await Promise.all([
          ctx.allRuns(), ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`, { timeout: remaining() }),
        ]);
        remaining();
        const human = comments.filter(row => row.companyId === source.companyId && row.issueId === source.id
          && row.authorUserId === state.humanId && !row.authorAgentId && !row.createdByRunId
          && row.body?.trim() === ctx.scenario.query.trim());
        const run = runs[0];
        if (ctx.issue()?.id !== source.id || source.conversationState !== "waiting" || runs.length !== 1 || !run
          || run.companyId !== source.companyId || run.agentId !== ctx.input.fixtures.agent.id || run.status !== "succeeded"
          || run.runtimeMode !== "native" || run.contextSnapshot?.issueId !== source.id || human.length !== 1
          || run.contextSnapshot?.commentId !== human[0]?.id
          || (run.contextSnapshot.taskId !== undefined && run.contextSnapshot.taskId !== source.id)
          || (run.nativeIssueId != null && run.nativeIssueId !== source.id)
          || !comments.some(row => row.companyId === source.companyId && row.issueId === source.id
            && row.authorAgentId === run.agentId && row.createdByRunId === run.id && !!row.body?.trim()))
          throw new Error("Team install initial reply is not bound to its canonical human and native request");
        state.first = await observeTeamResources(ctx);
        state.runtimeReadback = await verifyInstalledTeamRuntime(ctx, state.team as CatalogTeam, state.first as TeamResourceSnapshot, state.selectedRuntime as TeamInstallRuntime);
        state.initialRunId = (await ctx.allRuns())[0]?.id;
        state.firstConditional = await observeTeamConditions(ctx, state);
        const firstObservation = await observeExternal(ctx, state);
        // A later correct repeat cannot conceal an unaccounted initial outcome.
        const firstGrade = gradeTeamConditions(firstObservation, "initial");
        if (!firstGrade.passed)
          throw new Error(
            "Actual initial installer did not truthfully account for its genuine conflict or verified recovery before repeat",
          );
        await ctx.input.evidence("chat-catalog-team-initial-conditional.json", {
          initialRunId: state.initialRunId,
          condition: state.firstConditional,
          previewCollision: state.renamePlan,
        });
        state.repeatHumanQuery = ctx.scenario.query;
        await sendChatMessage(ctx.input.page, ctx.scenario.query);
      },
      async observe(ctx, state) {
        state.finalConditional = await observeTeamConditions(ctx, state);
        state.after = await observeTeamResources(ctx);
        return observeExternal(ctx, state);
      },
      async verifyResult(ctx, state, value) {
        await verifyRenderedReply(ctx, value, String(state.initialRunId));
        const team = state.team as CatalogTeam,
          after = state.after as TeamResourceSnapshot,
          o = externalObservation(value)!;
        const source = ctx.input.page.url();
        for (const member of catalogTeamMembers(after, team.id)) {
          const href = o.links.find((link) =>
            hasResourceLink(
              [link],
              o.origin,
              state.companyPrefix,
              "agents",
              member,
            ),
          );
          if (!href) throw new Error("Actual installed member link missing");
          await ctx.input.page.goto(new URL(href, o.origin).href, {
            waitUntil: "domcontentloaded",
          });
          await expect(ctx.input.page.getByRole("main")).toContainText(
            member.name,
          );
        }
        for (const project of after.projects.filter(
          (row) =>
            !(state.before as TeamResourceSnapshot).projects.some(
              (old) => old.id === row.id,
            ),
        )) {
          const href = o.links.find((link) =>
            hasResourceLink(
              [link],
              o.origin,
              state.companyPrefix,
              "projects",
              project,
            ),
          );
          if (!href) throw new Error("Actual installed project link missing");
          await ctx.input.page.goto(new URL(href, o.origin).href, {
            waitUntil: "domcontentloaded",
          });
          await expect(ctx.input.page.getByRole("main")).toContainText(
            project.name ?? "",
          );
        }
        await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
      },
      async cleanup(ctx, state) {
        const before = state.before as TeamResourceSnapshot | undefined;
        if (!before) return;
        for (const routine of await ctx.input.api.get<Resource[]>(
          `${root(ctx)}/routines`,
        ))
          if (!before.routines.some((row) => row.id === routine.id))
            await ctx.input.api.patch(`/api/routines/${routine.id}`, {
              status: "paused",
            });
        // Complete disposable-company teardown removes imported graph/provenance.
      },
    },
  ),
];
