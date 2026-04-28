import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  approvals,
  issues,
  rt2ReverseDesignRuns,
  rt2ProcessMiningSnapshots,
  rt2RuntimeSkillInjections,
} from "@paperclipai/db";
import type {
  Rt2JarvisReverseDesignProposal,
  Rt2JarvisSkillCapability,
} from "@paperclipai/shared";

export type ReverseDesignRun = {
  id: string;
  companyId: string;
  targetType: string;
  targetId: string;
  resultData: Record<string, unknown>;
  contextData: Record<string, unknown> | null;
  method: string;
  inferredCauses: Array<{
    cause: string;
    confidence: number;
    evidence: string[];
    relatedFactors: string[];
  }>;
  rootCause: string | null;
  confidenceScore: number;
  reconstructedProcess: Array<{
    step: number;
    action: string;
    inputs: string[];
    outputs: string[];
    rationale: string;
  }>;
  status: string;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProcessMiningSnapshot = {
  id: string;
  companyId: string;
  processType: string;
  processKey: string;
  traces: Array<{
    traceId: string;
    steps: Array<{
      stepId: string;
      action: string;
      startTime: string;
      endTime: string;
      duration: number;
      inputs: Record<string, unknown>;
      outputs: Record<string, unknown>;
      actor: string;
    }>;
    outcomes: {
      success: boolean;
      quality: number;
      duration: number;
    };
  }>;
  patterns: Array<{
    patternType: string;
    frequency: number;
    avgDuration: number;
    successRate: number;
    description: string;
  }>;
  bottlenecks: Array<{
    location: string;
    severity: string;
    avgWaitTime: number;
    frequency: number;
    recommendation: string;
  }>;
  totalExecutions: number;
  successRate: number;
  avgDurationMs: number;
  recommendations: Array<{
    priority: string;
    action: string;
    expectedImpact: string;
  }>;
  createdAt: Date;
  updatedAt: Date;
};

export type RuntimeSkillInjection = {
  id: string;
  companyId: string;
  agentId: string;
  skillId: string | null;
  skillKey: string;
  context: Record<string, unknown> | null;
  injectionType: string;
  status: string;
  effectivenessScore: number;
  usageCount: number;
  lastUsedAt: Date | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export function rt2AdvancedAIService(db: Db) {
  // ===== Reverse Design (역설계) =====

  /**
   * M3.4: Create reverse design analysis run
   */
  async function createReverseDesignRun(
    companyId: string,
    targetType: string,
    targetId: string,
    resultData: Record<string, unknown>,
    options?: {
      contextData?: Record<string, unknown>;
      method?: string;
    },
  ): Promise<ReverseDesignRun> {
    const [run] = await db
      .insert(rt2ReverseDesignRuns)
      .values({
        companyId,
        targetType,
        targetId,
        resultData,
        contextData: options?.contextData ?? null,
        method: options?.method ?? "auto",
      })
      .returning();

    return run as unknown as ReverseDesignRun;
  }

  /**
   * M3.4: Complete reverse design run with analysis
   */
  async function completeReverseDesignRun(
    runId: string,
    analysis: {
      inferredCauses: Array<{
        cause: string;
        confidence: number;
        evidence: string[];
        relatedFactors: string[];
      }>;
      rootCause?: string;
      confidenceScore: number;
      reconstructedProcess: Array<{
        step: number;
        action: string;
        inputs: string[];
        outputs: string[];
        rationale: string;
      }>;
    },
  ): Promise<ReverseDesignRun> {
    const [updated] = await db
      .update(rt2ReverseDesignRuns)
      .set({
        inferredCauses: analysis.inferredCauses as any,
        rootCause: analysis.rootCause ?? null,
        confidenceScore: analysis.confidenceScore,
        reconstructedProcess: analysis.reconstructedProcess as any,
        status: "completed",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2ReverseDesignRuns.id, runId))
      .returning();

    return updated as unknown as ReverseDesignRun;
  }

  /**
   * M3.4: Get reverse design runs for a target
   */
  async function getReverseDesignRuns(
    companyId: string,
    targetType?: string,
    targetId?: string,
  ): Promise<ReverseDesignRun[]> {
    const conditions = [eq(rt2ReverseDesignRuns.companyId, companyId)];
    if (targetType) {
      conditions.push(eq(rt2ReverseDesignRuns.targetType, targetType));
    }
    if (targetId) {
      conditions.push(eq(rt2ReverseDesignRuns.targetId, targetId));
    }

    const runs = await db
      .select()
      .from(rt2ReverseDesignRuns)
      .where(and(...conditions))
      .orderBy(desc(rt2ReverseDesignRuns.createdAt));

    return runs as unknown as ReverseDesignRun[];
  }

  async function proposeTasksFromExpectedDeliverable(
    companyId: string,
    expectedDeliverable: {
      title: string;
      type: string;
      description?: string | null;
      projectId?: string | null;
    },
  ): Promise<Rt2JarvisReverseDesignProposal> {
    const existingTasks = expectedDeliverable.projectId
      ? await db
        .select({
          id: issues.id,
          title: issues.title,
          status: issues.status,
          description: issues.description,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.projectId, expectedDeliverable.projectId)))
        .orderBy(desc(issues.updatedAt))
        .limit(5)
      : [];

    const deliverableText = [
      expectedDeliverable.title,
      expectedDeliverable.type,
      expectedDeliverable.description ?? "",
    ].join(" ").replace(/\s+/g, " ").trim();

    const evidence = [
      `expected deliverable: ${deliverableText}`,
      ...existingTasks.map((task) => `nearby task: ${task.title} (${task.status})`),
    ];

    const tasks = [
      {
        title: `${expectedDeliverable.title} 산출물 정의`,
        description: `${expectedDeliverable.type} 산출물을 완료 상태로 판단할 수 있도록 범위, owner, 검수 기준, base price 근거를 정리합니다.`,
        suggestedTodos: ["산출물 acceptance criteria 작성", "필요 입력자료 확인", "base price 또는 검수 기준 연결"],
        deliverableType: expectedDeliverable.type,
        evidence,
        rationale: "예상 산출물에서 완료 판정 기준을 먼저 역산해야 Task가 deliverable-first 작업 단위가 됩니다.",
        confidence: existingTasks.length > 0 ? 82 : 72,
      },
      {
        title: `${expectedDeliverable.title} 실행 및 검수 준비`,
        description: "산출물 제작 작업을 To-Do로 쪼개고 Jarvis 품질평가와 관리자 승인 경계를 준비합니다.",
        suggestedTodos: ["초안 제작", "Jarvis Shadow 평가 기록", "Co-Pilot 검토 요청 준비"],
        deliverableType: expectedDeliverable.type,
        evidence,
        rationale: "Phase 12의 변화관리 요구사항상 실행 Task는 품질평가와 approval routing 근거를 남겨야 합니다.",
        confidence: 78,
      },
    ];

    const run = await createReverseDesignRun(
      companyId,
      "expected_deliverable",
      randomUUID(),
      {
        expectedDeliverable,
        proposedTasks: tasks,
      },
      {
        contextData: { evidence, projectId: expectedDeliverable.projectId ?? null },
        method: "rt2_jarvis_reverse_task_design",
      },
    );

    const completed = await completeReverseDesignRun(run.id, {
      inferredCauses: tasks.map((task) => ({
        cause: task.title,
        confidence: task.confidence,
        evidence: task.evidence,
        relatedFactors: task.suggestedTodos,
      })),
      rootCause: "Expected deliverable requires traceable task decomposition before execution.",
      confidenceScore: Math.round(tasks.reduce((sum, task) => sum + task.confidence, 0) / tasks.length),
      reconstructedProcess: tasks.map((task, index) => ({
        step: index + 1,
        action: task.title,
        inputs: [expectedDeliverable.title, expectedDeliverable.type],
        outputs: [task.deliverableType],
        rationale: task.rationale,
      })),
    });

    return {
      companyId,
      expectedDeliverable: {
        title: expectedDeliverable.title,
        type: expectedDeliverable.type,
        description: expectedDeliverable.description ?? null,
      },
      runId: completed.id,
      tasks,
      rationale: "Jarvis reverse-designed tasks from the expected deliverable and persisted the rationale as a reverse design run.",
    };
  }

  // ===== Process Mining (프로세스 마이닝) =====

  /**
   * M3.4: Create or update process mining snapshot
   */
  async function upsertProcessMiningSnapshot(
    companyId: string,
    processType: string,
    processKey: string,
  ): Promise<ProcessMiningSnapshot> {
    const existing = await db
      .select()
      .from(rt2ProcessMiningSnapshots)
      .where(
        and(
          eq(rt2ProcessMiningSnapshots.companyId, companyId),
          eq(rt2ProcessMiningSnapshots.processType, processType),
          eq(rt2ProcessMiningSnapshots.processKey, processKey),
        ),
      )
      .limit(1);

    if (existing[0]) {
      return existing[0] as unknown as ProcessMiningSnapshot;
    }

    const [snapshot] = await db
      .insert(rt2ProcessMiningSnapshots)
      .values({
        companyId,
        processType,
        processKey,
      })
      .returning();

    return snapshot as unknown as ProcessMiningSnapshot;
  }

  /**
   * M3.4: Add traces to process mining snapshot
   */
  async function addProcessTraces(
    snapshotId: string,
    traces: Array<{
      traceId: string;
      steps: Array<{
        stepId: string;
        action: string;
        startTime: string;
        endTime: string;
        duration: number;
        inputs: Record<string, unknown>;
        outputs: Record<string, unknown>;
        actor: string;
      }>;
      outcomes: {
        success: boolean;
        quality: number;
        duration: number;
      };
    }>,
  ): Promise<ProcessMiningSnapshot> {
    const snapshot = await db
      .select()
      .from(rt2ProcessMiningSnapshots)
      .where(eq(rt2ProcessMiningSnapshots.id, snapshotId))
      .limit(1);

    if (!snapshot[0]) {
      throw new Error("Process mining snapshot not found");
    }

    const existingTraces = snapshot[0].traces as any[];
    const newTraces = [...existingTraces, ...traces];

    // Recalculate metrics
    const totalExecutions = newTraces.length;
    const successCount = newTraces.filter(t => t.outcomes.success).length;
    const successRate = Math.round((successCount / totalExecutions) * 100);
    const avgDurationMs = Math.round(
      newTraces.reduce((sum, t) => sum + t.outcomes.duration, 0) / totalExecutions,
    );

    const [updated] = await db
      .update(rt2ProcessMiningSnapshots)
      .set({
        traces: newTraces as any,
        totalExecutions,
        successRate,
        avgDurationMs,
        updatedAt: new Date(),
      })
      .where(eq(rt2ProcessMiningSnapshots.id, snapshotId))
      .returning();

    return updated as unknown as ProcessMiningSnapshot;
  }

  /**
   * M3.4: Update patterns and bottlenecks
   */
  async function updateProcessAnalysis(
    snapshotId: string,
    patterns: Array<{
      patternType: string;
      frequency: number;
      avgDuration: number;
      successRate: number;
      description: string;
    }>,
    bottlenecks: Array<{
      location: string;
      severity: string;
      avgWaitTime: number;
      frequency: number;
      recommendation: string;
    }>,
    recommendations: Array<{
      priority: string;
      action: string;
      expectedImpact: string;
    }>,
  ): Promise<ProcessMiningSnapshot> {
    const [updated] = await db
      .update(rt2ProcessMiningSnapshots)
      .set({
        patterns: patterns as any,
        bottlenecks: bottlenecks as any,
        recommendations: recommendations as any,
        updatedAt: new Date(),
      })
      .where(eq(rt2ProcessMiningSnapshots.id, snapshotId))
      .returning();

    return updated as unknown as ProcessMiningSnapshot;
  }

  /**
   * M3.4: Get process mining snapshots
   */
  async function getProcessMiningSnapshots(
    companyId: string,
    processType?: string,
  ): Promise<ProcessMiningSnapshot[]> {
    const conditions = [eq(rt2ProcessMiningSnapshots.companyId, companyId)];
    if (processType) {
      conditions.push(eq(rt2ProcessMiningSnapshots.processType, processType));
    }

    const snapshots = await db
      .select()
      .from(rt2ProcessMiningSnapshots)
      .where(and(...conditions))
      .orderBy(desc(rt2ProcessMiningSnapshots.createdAt));

    return snapshots as unknown as ProcessMiningSnapshot[];
  }

  // ===== Runtime Skill Injection =====

  /**
   * M3.4: Create skill injection
   */
  async function createSkillInjection(
    companyId: string,
    agentId: string,
    skillKey: string,
    options?: {
      skillId?: string;
      context?: Record<string, unknown>;
      injectionType?: string;
      expiresAt?: Date;
    },
  ): Promise<RuntimeSkillInjection> {
    const [injection] = await db
      .insert(rt2RuntimeSkillInjections)
      .values({
        companyId,
        agentId,
        skillKey,
        skillId: options?.skillId ?? null,
        context: options?.context ?? null,
        injectionType: options?.injectionType ?? "prompt",
        expiresAt: options?.expiresAt ?? null,
      })
      .returning();

    return injection as unknown as RuntimeSkillInjection;
  }

  async function createGovernedSkillCapability(
    companyId: string,
    agentId: string,
    skillKey: string,
    options?: {
      skillId?: string;
      context?: Record<string, unknown>;
      injectionType?: string;
      expiresAt?: Date;
      requestedByUserId?: string;
    },
  ): Promise<Rt2JarvisSkillCapability> {
    const injection = await createSkillInjection(companyId, agentId, skillKey, {
      skillId: options?.skillId,
      context: options?.context,
      injectionType: options?.injectionType ?? "prompt",
      expiresAt: options?.expiresAt,
    });

    const [approval] = await db
      .insert(approvals)
      .values({
        companyId,
        type: "jarvis_skill_capability",
        requestedByUserId: options?.requestedByUserId ?? null,
        status: "pending",
        payload: {
          title: `Jarvis skill capability: ${skillKey}`,
          injectionId: injection.id,
          agentId,
          skillKey,
          injectionType: injection.injectionType,
          context: options?.context ?? null,
        },
      })
      .returning();

    return mapSkillCapability(injection, approval?.id ?? null, approval?.status ?? null);
  }

  /**
   * M3.4: Activate skill injection
   */
  async function activateSkillInjection(injectionId: string): Promise<RuntimeSkillInjection> {
    const [updated] = await db
      .update(rt2RuntimeSkillInjections)
      .set({
        status: "active",
        activatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2RuntimeSkillInjections.id, injectionId))
      .returning();

    return updated as unknown as RuntimeSkillInjection;
  }

  /**
   * M3.4: Record skill injection usage
   */
  async function recordSkillInjectionUsage(injectionId: string): Promise<void> {
    await db
      .update(rt2RuntimeSkillInjections)
      .set({
        usageCount: sql`${rt2RuntimeSkillInjections.usageCount} + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2RuntimeSkillInjections.id, injectionId));
  }

  /**
   * M3.4: Update skill injection effectiveness
   */
  async function updateSkillInjectionEffectiveness(
    injectionId: string,
    effectivenessScore: number,
  ): Promise<RuntimeSkillInjection> {
    const [updated] = await db
      .update(rt2RuntimeSkillInjections)
      .set({
        effectivenessScore,
        updatedAt: new Date(),
      })
      .where(eq(rt2RuntimeSkillInjections.id, injectionId))
      .returning();

    return updated as unknown as RuntimeSkillInjection;
  }

  /**
   * M3.4: Deactivate skill injection
   */
  async function deactivateSkillInjection(injectionId: string): Promise<RuntimeSkillInjection> {
    const [updated] = await db
      .update(rt2RuntimeSkillInjections)
      .set({
        status: "expired",
        deactivatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2RuntimeSkillInjections.id, injectionId))
      .returning();

    return updated as unknown as RuntimeSkillInjection;
  }

  /**
   * M3.4: Get active skill injections for an agent
   */
  async function getActiveSkillInjections(agentId: string): Promise<RuntimeSkillInjection[]> {
    const injections = await db
      .select()
      .from(rt2RuntimeSkillInjections)
      .where(
        and(
          eq(rt2RuntimeSkillInjections.agentId, agentId),
          eq(rt2RuntimeSkillInjections.status, "active"),
        ),
      )
      .orderBy(desc(rt2RuntimeSkillInjections.activatedAt));

    return injections as unknown as RuntimeSkillInjection[];
  }

  async function listSkillCapabilities(
    companyId: string,
    agentId?: string,
  ): Promise<Rt2JarvisSkillCapability[]> {
    const conditions = [eq(rt2RuntimeSkillInjections.companyId, companyId)];
    if (agentId) {
      conditions.push(eq(rt2RuntimeSkillInjections.agentId, agentId));
    }

    const injections = await db
      .select()
      .from(rt2RuntimeSkillInjections)
      .where(and(...conditions))
      .orderBy(desc(rt2RuntimeSkillInjections.createdAt))
      .limit(100);

    const approvalRows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.type, "jarvis_skill_capability")))
      .orderBy(desc(approvals.createdAt));

    return injections.map((injection) => {
      const approval = approvalRows.find((row) => {
        const payload = row.payload as Record<string, unknown>;
        return payload.injectionId === injection.id;
      });
      return mapSkillCapability(
        injection as RuntimeSkillInjection,
        approval?.id ?? null,
        approval?.status ?? null,
      );
    });
  }

  return {
    // Reverse Design
    createReverseDesignRun,
    completeReverseDesignRun,
    getReverseDesignRuns,
    proposeTasksFromExpectedDeliverable,
    // Process Mining
    upsertProcessMiningSnapshot,
    addProcessTraces,
    updateProcessAnalysis,
    getProcessMiningSnapshots,
    // Runtime Skill Injection
    createSkillInjection,
    createGovernedSkillCapability,
    activateSkillInjection,
    recordSkillInjectionUsage,
    updateSkillInjectionEffectiveness,
    deactivateSkillInjection,
    getActiveSkillInjections,
    listSkillCapabilities,
  };
}

function mapSkillCapability(
  injection: RuntimeSkillInjection,
  approvalId: string | null,
  approvalStatus: string | null,
): Rt2JarvisSkillCapability {
  return {
    injectionId: injection.id,
    companyId: injection.companyId,
    agentId: injection.agentId,
    skillId: injection.skillId,
    skillKey: injection.skillKey,
    injectionType: injection.injectionType,
    status: injection.status,
    approvalId,
    approvalStatus: approvalStatus as Rt2JarvisSkillCapability["approvalStatus"],
    effectivenessScore: injection.effectivenessScore,
    usageCount: injection.usageCount,
    lastUsedAt: injection.lastUsedAt,
    activatedAt: injection.activatedAt,
    expiresAt: injection.expiresAt,
    policy: {
      governed: true,
      reason: "Runtime skill attachment changes Jarvis capability and must be visible in governance.",
    },
  };
}
