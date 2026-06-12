import type { Agent, Issue, Project } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";

export type CommandCenterGateTone = "queued" | "running" | "approval" | "guardrail" | "stale" | "complete";

export interface CommandCenterGate {
  label: string;
  nextAction: string;
  tone: CommandCenterGateTone;
}

export interface CommandCenterLiveRun {
  runId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  status: string;
  startedAt: string | null;
  elapsedMs: number | null;
  livenessState: LiveRunForIssue["livenessState"];
  nextAction: string | null;
}

export interface CommandCenterSquadRole {
  label: string;
  scope: string;
  internal: boolean;
}

export interface CommandCenterHandoffStep {
  label: string;
  detail: string;
  tone: CommandCenterGateTone;
}

export type CommandCenterWorkstreamKind = "real_work_now" | "automation_supervision" | "administrative_mirror";

export interface CommandCenterWorkstream {
  kind: CommandCenterWorkstreamKind;
  label: string;
  detail: string;
}

export interface CommandCenterIssueTrace {
  id: string;
  identifier: string;
  projectId: string | null;
  projectName: string;
  projectDisplayLabel: string;
  title: string;
  status: string;
  priority: string;
  responsible: string;
  squadRole: CommandCenterSquadRole | null;
  agentId: string | null;
  gate: CommandCenterGate;
  handoffTrail: CommandCenterHandoffStep[];
  branchOrWorkspace: string | null;
  updatedAt: Date | string;
  liveRun: CommandCenterLiveRun | null;
  workstream: CommandCenterWorkstream;
}

export interface CommandCenterProjectGroup {
  projectId: string | null;
  projectName: string;
  projectStatus: string | null;
  activeIssueCount: number;
  issues: CommandCenterIssueTrace[];
}

export interface CommandCenterTrace {
  groups: CommandCenterProjectGroup[];
  totalActiveIssues: number;
  realWorkNowCount: number;
  automationSupervisionCount: number;
  administrativeMirrorCount: number;
  reviewGateCount: number;
  guardrailCount: number;
}

export interface BuildCommandCenterTraceInput {
  projects: Project[];
  issues: Issue[];
  agents: Agent[];
}

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled", "backlog"]);
const STALE_GATE_THRESHOLD_MS = 72 * 60 * 60 * 1000;
const SUPERVISION_ORIGIN_KINDS = new Set([
  "routine_execution",
  "stale_active_run_evaluation",
  "harness_liveness_escalation",
  "issue_productivity_review",
  "stranded_issue_recovery",
]);
const ADMINISTRATIVE_MIRROR_ORIGIN_KINDS = new Set([
  "stale_active_run_evaluation",
  "harness_liveness_escalation",
  "issue_productivity_review",
  "stranded_issue_recovery",
]);
const ADMINISTRATIVE_MIRROR_TITLE_PATTERNS = [
  /\b(active run|run)\s+(watchdog|evaluation|liveness)\b/i,
  /\b(issue graph|harness)\s+liveness\b/i,
  /\b(productivity review|stranded issue|missing disposition|auto[- ]?recovery)\b/i,
];

export const AI_OPS_SQUAD_ROLES: Record<string, CommandCenterSquadRole> = {
  maestro: {
    label: "Maestro",
    scope: "Orquestração, Paperclip, Obsidian, priorização e passagem de bastão.",
    internal: true,
  },
  dedalo: {
    label: "Dédalo",
    scope: "Execução residente da DelegAI e implementação de apps.",
    internal: true,
  },
  polux: {
    label: "Pólux",
    scope: "Execução contínua do JurisX.",
    internal: true,
  },
  atena: {
    label: "Atena",
    scope: "Execução contínua do LucrosX.",
    internal: true,
  },
  apolo: {
    label: "Apolo",
    scope: "Frontend e acabamento de UI.",
    internal: true,
  },
  ariadne: {
    label: "Ariadne",
    scope: "Produto, UX, copy e critérios de aceite.",
    internal: true,
  },
  arquimedes: {
    label: "Arquimedes",
    scope: "Arquitetura, revisão técnica e consistência do Paperclip.",
    internal: true,
  },
  sentinela: {
    label: "Sentinela",
    scope: "AppSec, risco e validação de guardrails.",
    internal: true,
  },
  guardiao: {
    label: "Portão externo",
    scope: "Portão externo para infra, produção, secrets/DBs reais, DNS, firewall e permissões amplas.",
    internal: false,
  },
};

function normalizeSquadRoleKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")[0] ?? "";
}

export function resolveCommandCenterSquadRole(agent: Pick<Agent, "name"> | null): CommandCenterSquadRole | null {
  if (!agent?.name) return null;
  return AI_OPS_SQUAD_ROLES[normalizeSquadRoleKey(agent.name)] ?? null;
}

function isQueuedForCommandCenter(issue: Issue): boolean {
  return !issue.executionRunId && !issue.checkoutRunId && issue.status === "todo";
}

function isStaleQueuedIssue(issue: Issue, now = new Date()): boolean {
  if (!isQueuedForCommandCenter(issue)) return false;

  const updatedAt = new Date(issue.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;

  return now.getTime() - updatedAt > STALE_GATE_THRESHOLD_MS;
}

function issueDisplayId(issue: Issue): string {
  return issue.identifier ?? issue.id.slice(0, 8);
}

export function formatCommandCenterStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    backlog: "backlog",
    todo: "a fazer",
    in_progress: "em execução",
    in_review: "em revisão",
    blocked: "bloqueada",
    done: "concluída",
    cancelled: "cancelada",
  };
  return labels[status] ?? status.replace(/_/g, " ");
}

function isAdministrativeMirrorIssue(issue: Issue): boolean {
  const originKind = issue.originKind ?? null;
  if (originKind && ADMINISTRATIVE_MIRROR_ORIGIN_KINDS.has(originKind)) return true;
  return ADMINISTRATIVE_MIRROR_TITLE_PATTERNS.some((pattern) => pattern.test(issue.title));
}

function deriveCommandCenterWorkstream(issue: Issue, hasLiveRun = false): CommandCenterWorkstream {
  if (hasLiveRun || issue.executionRunId || issue.checkoutRunId || issue.status === "in_progress") {
    return {
      kind: "real_work_now",
      label: "Trabalho real agora",
      detail: "Execução ativa ligada a run, checkout ou trabalho em progresso.",
    };
  }

  if (isAdministrativeMirrorIssue(issue)) {
    return {
      kind: "administrative_mirror",
      label: "Espelho administrativo",
      detail: "Item de supervisão/recuperação; não tratar como entrega em execução.",
    };
  }

  if (issue.originKind && SUPERVISION_ORIGIN_KINDS.has(issue.originKind)) {
    return {
      kind: "automation_supervision",
      label: "Automação/supervisão",
      detail: "Item criado por rotina ou monitoramento, separado do trabalho manual principal.",
    };
  }

  return {
    kind: "real_work_now",
    label: "Trabalho real agora",
    detail: "Trabalho de produto/engenharia visível no cockpit.",
  };
}

export function deriveCommandCenterGate(issue: Issue): CommandCenterGate {
  if (isAdministrativeMirrorIssue(issue)) {
    return {
      label: "Espelho administrativo",
      nextAction: "Acompanhar como supervisão; não confundir com execução real do produto.",
      tone: "queued",
    };
  }

  if (issue.status === "blocked") {
    return {
      label: "Guardrail externo",
      nextAction: "Resolver bloqueio antes de permitir mais execução autônoma.",
      tone: "guardrail",
    };
  }

  if (issue.status === "in_review") {
    return {
      label: "Portão de aprovação JP",
      nextAction: "Revisar a entrega e aprovar, pedir ajustes ou fechar a issue.",
      tone: "approval",
    };
  }

  if (issue.executionRunId || issue.checkoutRunId || issue.status === "in_progress") {
    return {
      label: "Execução do agente",
      nextAction: "Monitorar a run ativa e registrar evidência de branch/workspace antes da revisão.",
      tone: "running",
    };
  }

  if (isStaleQueuedIssue(issue)) {
    return {
      label: "Parado — precisa de atenção",
      nextAction: "Sem atividade há mais de 72 horas. Revisar responsável e prioridade.",
      tone: "stale",
    };
  }

  if (!issue.assigneeAgentId && !issue.assigneeUserId) {
    return {
      label: "Precisa de responsável",
      nextAction: "Atribuir um responsável antes de iniciar a execução.",
      tone: "queued",
    };
  }

  return {
    label: "Pronto para execução",
    nextAction: "Iniciar ou agendar trabalho do agente quando JP aprovar o próximo movimento.",
    tone: "queued",
  };
}

function buildCommandCenterHandoffTrail(
  issue: Issue,
  agent: Pick<Agent, "name"> | null,
  gate: CommandCenterGate,
): CommandCenterHandoffStep[] {
  const responsible = agent?.name ?? (issue.assigneeUserId ? "Operador do board" : "Sem responsável");
  const trail: CommandCenterHandoffStep[] = [
    {
      label: "Entrada",
      detail: issue.identifier ? `${issue.identifier} recebido com status ${formatCommandCenterStatusLabel(issue.status)}` : `Issue recebida com status ${formatCommandCenterStatusLabel(issue.status)}`,
      tone: "queued",
    },
    {
      label: "Responsável",
      detail: responsible,
      tone: issue.assigneeAgentId || issue.assigneeUserId ? "running" : "queued",
    },
  ];

  if (issue.executionRunId || issue.checkoutRunId || issue.status === "in_progress") {
    trail.push({
      label: "Execução",
      detail: issue.executionRunId ?? issue.checkoutRunId ?? "Trabalho ativo",
      tone: "running",
    });
  }

  trail.push({
    label: gate.label,
    detail: gate.nextAction,
    tone: gate.tone,
  });

  return trail;
}

export function buildCommandCenterTrace(input: BuildCommandCenterTraceInput): CommandCenterTrace {
  const projectMap = new Map(input.projects.map((project) => [project.id, project]));
  const agentMap = new Map(input.agents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, CommandCenterProjectGroup>();

  const activeIssues = input.issues
    .filter((issue) => !TERMINAL_ISSUE_STATUSES.has(issue.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  for (const issue of activeIssues) {
    const project = issue.projectId ? projectMap.get(issue.projectId) ?? null : null;
    const groupKey = project?.id ?? "__unscoped__";
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        projectId: project?.id ?? null,
        projectName: project?.name ?? "Trabalho sem projeto",
        projectStatus: project?.status ?? null,
        activeIssueCount: 0,
        issues: [],
      };
      groups.set(groupKey, group);
    }

    const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) ?? null : null;
    const branchOrWorkspace = issue.executionWorkspacePreference
      ?? issue.executionWorkspaceId
      ?? issue.projectWorkspaceId
      ?? null;
    const gate = deriveCommandCenterGate(issue);
    const workstream = deriveCommandCenterWorkstream(issue);
    group.issues.push({
      id: issue.id,
      identifier: issueDisplayId(issue),
      projectId: project?.id ?? null,
      projectName: group.projectName,
      projectDisplayLabel: `${group.projectName} · ${issueDisplayId(issue)}`,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      responsible: agent?.name ?? (issue.assigneeUserId ? "Operador do board" : "Sem responsável"),
      squadRole: resolveCommandCenterSquadRole(agent),
      agentId: agent?.id ?? null,
      gate,
      handoffTrail: buildCommandCenterHandoffTrail(issue, agent, gate),
      branchOrWorkspace,
      updatedAt: issue.updatedAt,
      liveRun: null,
      workstream,
    });
    group.activeIssueCount += 1;
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    if (a.projectId === null && b.projectId !== null) return 1;
    if (a.projectId !== null && b.projectId === null) return -1;
    return a.projectName.localeCompare(b.projectName);
  });

  const workstreams = activeIssues.map((issue) => deriveCommandCenterWorkstream(issue));

  return {
    groups: sortedGroups,
    totalActiveIssues: activeIssues.length,
    realWorkNowCount: workstreams.filter((workstream) => workstream.kind === "real_work_now").length,
    automationSupervisionCount: workstreams.filter((workstream) => workstream.kind === "automation_supervision").length,
    administrativeMirrorCount: workstreams.filter((workstream) => workstream.kind === "administrative_mirror").length,
    reviewGateCount: activeIssues.filter((issue) => issue.status === "in_review").length,
    guardrailCount: activeIssues.filter((issue) => issue.status === "blocked").length,
  };
}

const LIVE_RUN_STATUSES = new Set(["queued", "running"]);

function buildLiveRunEntry(run: LiveRunForIssue, now: Date): CommandCenterLiveRun {
  const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const elapsedMs = startedMs && !Number.isNaN(startedMs) ? now.getTime() - startedMs : null;
  return {
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterType: run.adapterType,
    status: run.status,
    startedAt: run.startedAt,
    elapsedMs,
    livenessState: run.livenessState,
    nextAction: run.nextAction ?? null,
  };
}

function formatLiveRunDetail(liveRun: CommandCenterLiveRun): string {
  const next = liveRun.nextAction ? ` · ${liveRun.nextAction}` : "";
  return `${liveRun.agentName} (${liveRun.adapterType}) · ${liveRun.status}/${liveRun.livenessState}${next}`;
}

export function enrichCommandCenterWithLiveRuns(
  trace: CommandCenterTrace,
  liveRuns: readonly LiveRunForIssue[],
  now = new Date(),
): CommandCenterTrace {
  const activeByIssue = new Map<string, LiveRunForIssue>();
  for (const run of liveRuns) {
    if (!run.issueId || !LIVE_RUN_STATUSES.has(run.status)) continue;
    const existing = activeByIssue.get(run.issueId);
    if (!existing || run.createdAt > existing.createdAt) {
      activeByIssue.set(run.issueId, run);
    }
  }

  if (activeByIssue.size === 0) return trace;

  let realWorkNowCount = trace.realWorkNowCount;
  let automationSupervisionCount = trace.automationSupervisionCount;
  let administrativeMirrorCount = trace.administrativeMirrorCount;

  const groups = trace.groups.map((group) => ({
    ...group,
    issues: group.issues.map((issueTrace) => {
      const run = activeByIssue.get(issueTrace.id);
      if (!run) return issueTrace;
      const liveRun = buildLiveRunEntry(run, now);
      if (issueTrace.workstream.kind !== "real_work_now") {
        realWorkNowCount += 1;
        if (issueTrace.workstream.kind === "automation_supervision") automationSupervisionCount -= 1;
        if (issueTrace.workstream.kind === "administrative_mirror") administrativeMirrorCount -= 1;
      }
      return {
        ...issueTrace,
        liveRun,
        workstream: {
          kind: "real_work_now" as const,
          label: "Trabalho real agora",
          detail: "Execução real ativa no heartbeat, mesmo que a issue pareça fila/supervisão.",
        },
        gate: {
          label: "Trabalho real agora",
          nextAction: liveRun.nextAction ?? "Acompanhar a run ativa pelo heartbeat e colher evidência da entrega.",
          tone: "running" as const,
        },
        handoffTrail: [
          ...issueTrace.handoffTrail,
          {
            label: "Execução real",
            detail: formatLiveRunDetail(liveRun),
            tone: "running" as const,
          },
        ],
      };
    }),
  }));

  return {
    ...trace,
    groups,
    realWorkNowCount,
    automationSupervisionCount,
    administrativeMirrorCount,
  };
}
