import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Issue, Project } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { buildCommandCenterTrace, deriveCommandCenterGate, enrichCommandCenterWithLiveRuns, formatCommandCenterStatusLabel, resolveCommandCenterSquadRole } from "./command-center";

function project(overrides: Partial<Project>): Project {
  return {
    id: "project-1",
    companyId: "company-1",
    urlKey: "project-one",
    goalId: null,
    goalIds: [],
    goals: [],
    name: "Project One",
    description: null,
    status: "in_progress",
    leadAgentId: null,
    targetDate: null,
    color: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    executionWorkspacePolicy: null,
    codebase: {} as Project["codebase"],
    workspaces: [],
    primaryWorkspace: null,
    archivedAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Dédalo",
    urlKey: "dedalo",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Trace work",
    description: null,
    status: "todo",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

describe("deriveCommandCenterGate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flags queued work with no updates for over 72 hours as stale", () => {
    vi.setSystemTime(new Date("2026-05-05T00:00:00Z"));

    expect(deriveCommandCenterGate(issue({ status: "todo", updatedAt: new Date("2026-05-01T23:59:59Z") }))).toEqual({
      label: "Parado — precisa de atenção",
      nextAction: "Sem atividade há mais de 72 horas. Revisar responsável e prioridade.",
      tone: "stale",
    });
  });

  it("keeps queued work updated within 72 hours in the normal queue", () => {
    vi.setSystemTime(new Date("2026-05-05T00:00:00Z"));

    expect(deriveCommandCenterGate(issue({ status: "todo", updatedAt: new Date("2026-05-02T00:00:01Z") }))).toEqual({
      label: "Precisa de responsável",
      nextAction: "Atribuir um responsável antes de iniciar a execução.",
      tone: "queued",
    });
  });

  it("flags review work as a JP approval gate", () => {
    expect(deriveCommandCenterGate(issue({ status: "in_review" }))).toEqual({
      label: "Portão de aprovação JP",
      nextAction: "Revisar a entrega e aprovar, pedir ajustes ou fechar a issue.",
      tone: "approval",
    });
  });

  it("keeps blocked work at an external guardrail", () => {
    expect(deriveCommandCenterGate(issue({ status: "blocked" }))).toEqual({
      label: "Guardrail externo",
      nextAction: "Resolver bloqueio antes de permitir mais execução autônoma.",
      tone: "guardrail",
    });
  });
});

describe("buildCommandCenterTrace", () => {
  it("formats Command Center status labels for operator-facing PT-BR badges", () => {
    expect(formatCommandCenterStatusLabel("todo")).toBe("a fazer");
    expect(formatCommandCenterStatusLabel("in_progress")).toBe("em execução");
    expect(formatCommandCenterStatusLabel("in_review")).toBe("em revisão");
    expect(formatCommandCenterStatusLabel("unknown_status")).toBe("unknown status");
  });

  it("maps fixed AI Ops squad roles from assigned agents without schema changes", () => {
    expect(resolveCommandCenterSquadRole(agent({ name: "Dédalo" }))).toEqual({
      label: "Dédalo",
      scope: "Execução residente da DelegAI e implementação de apps.",
      internal: true,
    });
    expect(resolveCommandCenterSquadRole(agent({ name: "Guardião" }))).toEqual({
      label: "Portão externo",
      scope: "Portão externo para infra, produção, secrets/DBs reais, DNS, firewall e permissões amplas.",
      internal: false,
    });
    expect(resolveCommandCenterSquadRole(agent({ name: "External Vendor" }))).toBeNull();
  });

  it("groups active issues by project and resolves the responsible agent", () => {
    const trace = buildCommandCenterTrace({
      projects: [project({ id: "project-1", name: "Paperclip" })],
      agents: [agent({ id: "agent-1", name: "Dédalo" })],
      issues: [
        issue({
          id: "issue-1",
          projectId: "project-1",
          identifier: "JPP-32",
          title: "Build visual traceability",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: "agent-1",
          executionRunId: "run-1",
          executionWorkspacePreference: "branch:paperclip-command-center-visual-traceability",
        }),
        issue({ id: "done-issue", projectId: "project-1", status: "done" }),
        issue({ id: "backlog-issue", projectId: "project-1", status: "backlog" }),
      ],
    });

    expect(trace.groups).toHaveLength(1);
    expect(trace.groups[0]?.projectName).toBe("Paperclip");
    expect(trace.groups[0]?.issues).toHaveLength(1);
    expect(trace.groups[0]?.issues[0]).toMatchObject({
      identifier: "JPP-32",
      projectId: "project-1",
      projectName: "Paperclip",
      projectDisplayLabel: "Paperclip · JPP-32",
      title: "Build visual traceability",
      status: "in_progress",
      priority: "high",
      responsible: "Dédalo",
      squadRole: {
        label: "Dédalo",
        scope: "Execução residente da DelegAI e implementação de apps.",
        internal: true,
      },
      branchOrWorkspace: "branch:paperclip-command-center-visual-traceability",
      handoffTrail: [
        { label: "Entrada", detail: "JPP-32 recebido com status em execução", tone: "queued" },
        { label: "Responsável", detail: "Dédalo", tone: "running" },
        { label: "Execução", detail: "run-1", tone: "running" },
        {
          label: "Execução do agente",
          detail: "Monitorar a run ativa e registrar evidência de branch/workspace antes da revisão.",
          tone: "running",
        },
      ],
      gate: {
        label: "Execução do agente",
        nextAction: "Monitorar a run ativa e registrar evidência de branch/workspace antes da revisão.",
        tone: "running",
      },
      workstream: {
        kind: "real_work_now",
        label: "Trabalho real agora",
      },
    });
  });

  it("keeps unassigned active issues visible in an unscoped group", () => {
    const trace = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [issue({ id: "issue-2", identifier: "OPS-7", status: "todo", priority: "critical", updatedAt: new Date() })],
    });

    expect(trace.groups).toHaveLength(1);
    expect(trace.groups[0]?.projectName).toBe("Trabalho sem projeto");
    expect(trace.groups[0]?.issues[0]?.projectDisplayLabel).toBe("Trabalho sem projeto · OPS-7");
    expect(trace.groups[0]?.issues[0]?.responsible).toBe("Sem responsável");
    expect(trace.groups[0]?.issues[0]?.gate.nextAction).toBe("Atribuir um responsável antes de iniciar a execução.");
  });

  it("does not surface PR or CI metadata without a real data contract", () => {
    const trace = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [
        issue({
          id: "issue-3",
          executionWorkspaceId: "workspace-1",
          executionWorkspaceSettings: { prUrl: "https://example.com/pr/1" } as Issue["executionWorkspaceSettings"],
        }),
      ],
    });

    expect(trace.groups[0]?.issues[0]?.branchOrWorkspace).toBe("workspace-1");
    expect("prOrCi" in (trace.groups[0]?.issues[0] ?? {})).toBe(false);
  });
  it("classifies administrative mirrors without presenting them as real execution", () => {
    const trace = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [
        issue({
          id: "admin-1",
          title: "Issue graph liveness auto-recovery",
          originKind: "harness_liveness_escalation",
          status: "todo",
          updatedAt: new Date(),
        }),
        issue({
          id: "routine-1",
          title: "Nightly sync routine",
          originKind: "routine_execution",
          status: "todo",
          updatedAt: new Date(),
        }),
      ],
    });

    expect(trace.realWorkNowCount).toBe(0);
    expect(trace.automationSupervisionCount).toBe(1);
    expect(trace.administrativeMirrorCount).toBe(1);
    expect(trace.groups[0]?.issues[0]).toMatchObject({
      gate: {
        label: "Espelho administrativo",
        nextAction: "Acompanhar como supervisão; não confundir com execução real do produto.",
        tone: "queued",
      },
      workstream: {
        kind: "administrative_mirror",
        label: "Espelho administrativo",
      },
    });
  });
});

function liveRun(overrides: Partial<LiveRunForIssue> = {}): LiveRunForIssue {
  return {
    id: "run-1",
    status: "running",
    invocationSource: "scheduler",
    triggerDetail: null,
    startedAt: "2026-05-21T10:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-05-21T10:00:00.000Z",
    agentId: "agent-1",
    agentName: "Arquimedes",
    adapterType: "claude_code",
    issueId: "issue-1",
    livenessState: "advanced",
    nextAction: "Running tests",
    ...overrides,
  };
}

describe("enrichCommandCenterWithLiveRuns", () => {
  it("attaches a live run to a matching issue and computes elapsedMs", () => {
    const base = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [issue({ id: "issue-1", identifier: "JPP-60", status: "in_progress", assigneeAgentId: "agent-1", executionRunId: "run-old", updatedAt: new Date("2026-05-21T09:00:00Z") })],
    });

    const now = new Date("2026-05-21T10:30:00.000Z");
    const enriched = enrichCommandCenterWithLiveRuns(base, [liveRun({})], now);

    const live = enriched.groups[0]?.issues[0]?.liveRun;
    expect(live).not.toBeNull();
    expect(live?.runId).toBe("run-1");
    expect(live?.agentName).toBe("Arquimedes");
    expect(live?.adapterType).toBe("claude_code");
    expect(live?.livenessState).toBe("advanced");
    expect(live?.nextAction).toBe("Running tests");
    expect(live?.elapsedMs).toBe(30 * 60 * 1000);
  });

  it("returns the original trace unchanged when no active live runs match", () => {
    const base = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [issue({ id: "issue-2", status: "todo", updatedAt: new Date() })],
    });

    const enriched = enrichCommandCenterWithLiveRuns(base, [], new Date());

    expect(enriched).toBe(base);
    expect(enriched.groups[0]?.issues[0]?.liveRun).toBeNull();
  });

  it("ignores terminal-status runs (succeeded, failed, cancelled)", () => {
    const base = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [issue({ id: "issue-1", status: "in_progress", executionRunId: "run-1", updatedAt: new Date() })],
    });

    const enriched = enrichCommandCenterWithLiveRuns(
      base,
      [liveRun({ status: "succeeded" }), liveRun({ status: "failed" }), liveRun({ status: "cancelled" })],
      new Date(),
    );

    expect(enriched).toBe(base);
    expect(enriched.groups[0]?.issues[0]?.liveRun).toBeNull();
  });

  it("picks the most recent run when multiple active runs exist for the same issue", () => {
    const base = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [issue({ id: "issue-1", status: "in_progress", executionRunId: "run-earlier", updatedAt: new Date() })],
    });

    const earlier = liveRun({ id: "run-earlier", createdAt: "2026-05-21T09:00:00.000Z", agentName: "Dédalo" });
    const later = liveRun({ id: "run-later", createdAt: "2026-05-21T10:00:00.000Z", agentName: "Arquimedes" });

    const enriched = enrichCommandCenterWithLiveRuns(base, [earlier, later], new Date());

    expect(enriched.groups[0]?.issues[0]?.liveRun?.runId).toBe("run-later");
    expect(enriched.groups[0]?.issues[0]?.liveRun?.agentName).toBe("Arquimedes");
  });

  it("sets elapsedMs to null when startedAt is absent", () => {
    const base = buildCommandCenterTrace({
      projects: [],
      agents: [],
      issues: [issue({ id: "issue-1", status: "in_progress", executionRunId: "run-1", updatedAt: new Date() })],
    });

    const enriched = enrichCommandCenterWithLiveRuns(base, [liveRun({ startedAt: null })], new Date());

    expect(enriched.groups[0]?.issues[0]?.liveRun?.elapsedMs).toBeNull();
  });
});
