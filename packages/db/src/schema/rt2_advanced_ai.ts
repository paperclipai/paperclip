import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Reverse design runs - analyze results to infer causes/process
 * M3.4: 역설계 (결과→원인)
 */
export const rt2ReverseDesignRuns = pgTable(
  "rt2_reverse_design_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Target to analyze
    targetType: text("target_type").notNull(), // 'task', 'deliverable', 'process', 'output'
    targetId: uuid("target_id").notNull(),
    // Analysis inputs
    resultData: jsonb("result_data").$type<Record<string, unknown>>().notNull(),
    contextData: jsonb("context_data").$type<Record<string, unknown>>(),
    // Analysis method
    method: text("method").notNull().default("auto"), // 'auto', 'llm', 'pattern_match'
    // Inferred causes
    inferredCauses: jsonb("inferred_causes").$type<Array<{
      cause: string;
      confidence: number;
      evidence: string[];
      relatedFactors: string[];
    }>>().notNull().default([]),
    // Root cause analysis
    rootCause: text("root_cause"),
    confidenceScore: integer("confidence_score").notNull().default(0), // 0-100
    // Process reconstruction
    reconstructedProcess: jsonb("reconstructed_process").$type<Array<{
      step: number;
      action: string;
      inputs: string[];
      outputs: string[];
      rationale: string;
    }>>().notNull().default([]),
    // Status
    status: text("status").notNull().default("pending"), // 'pending', 'running', 'completed', 'failed'
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("reverse_design_runs_company_idx").on(table.companyId),
    targetIdx: index("reverse_design_runs_target_idx").on(table.targetType, table.targetId),
    statusIdx: index("reverse_design_runs_status_idx").on(table.status),
  }),
);

/**
 * Process mining snapshots - capture and analyze process execution
 * M3.4: 프로세스 마이닝
 */
export const rt2ProcessMiningSnapshots = pgTable(
  "rt2_process_mining_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Process definition
    processType: text("process_type").notNull(), // 'task_execution', 'code_review', 'deployment', 'analysis'
    processKey: text("process_key").notNull(), // unique identifier for the process
    // Execution traces
    traces: jsonb("traces").$type<Array<{
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
    }>>().notNull().default([]),
    // Pattern analysis
    patterns: jsonb("patterns").$type<Array<{
      patternType: string;
      frequency: number;
      avgDuration: number;
      successRate: number;
      description: string;
    }>>().notNull().default([]),
    // Bottlenecks identified
    bottlenecks: jsonb("bottlenecks").$type<Array<{
      location: string;
      severity: string;
      avgWaitTime: number;
      frequency: number;
      recommendation: string;
    }>>().notNull().default([]),
    // Process metrics
    totalExecutions: integer("total_executions").notNull().default(0),
    successRate: integer("success_rate").notNull().default(0), // 0-100
    avgDurationMs: integer("avg_duration_ms").notNull().default(0),
    // Recommendations
    recommendations: jsonb("recommendations").$type<Array<{
      priority: string;
      action: string;
      expectedImpact: string;
    }>>().notNull().default([]),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("process_mining_snapshots_company_idx").on(table.companyId),
    processTypeIdx: index("process_mining_snapshots_process_type_idx").on(table.processType),
    processKeyIdx: index("process_mining_snapshots_process_key_idx").on(table.processKey),
  }),
);

/**
 * Runtime skill injections - dynamically inject skills into agents
 * M3.4: Runtime Skill Injection
 */
export const rt2RuntimeSkillInjections = pgTable(
  "rt2_runtime_skill_injections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    // Target
    agentId: uuid("agent_id").notNull(),
    // Skill to inject
    skillId: uuid("skill_id").references(() => companies.id), // reference to company_skills.id
    skillKey: text("skill_key").notNull(),
    // Injection context
    context: jsonb("context").$type<Record<string, unknown>>(),
    // Injection method
    injectionType: text("injection_type").notNull().default("prompt"), // 'prompt', 'system_message', 'example', 'template'
    // Status
    status: text("status").notNull().default("pending"), // 'pending', 'active', 'expired', 'failed'
    // Effectiveness tracking
    effectivenessScore: integer("effectiveness_score").notNull().default(0), // 0-100
    usageCount: integer("usage_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Lifecycle
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    // Timestamps
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("runtime_skill_injections_company_idx").on(table.companyId),
    agentIdx: index("runtime_skill_injections_agent_idx").on(table.agentId),
    skillKeyIdx: index("runtime_skill_injections_skill_key_idx").on(table.skillKey),
    statusIdx: index("runtime_skill_injections_status_idx").on(table.status),
  }),
);