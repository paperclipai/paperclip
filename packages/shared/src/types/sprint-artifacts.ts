/**
 * TypeScript interfaces for Sprint Co artifact parsing
 * Defines the structure of all sprint artifacts for type safety
 */

/**
 * Core sprint plan data extracted from sprint-plan.md
 */
export interface SprintPlanData {
  sprintId: string;
  brief: string;
  productName: string;
  targetUser: string;
  primaryFlow: string;
  dataModel: string;
  techStack: string;
  vLabelBreakdown: VLabelBreakdown;
  riskAssessment: string[];
}

/**
 * V-label breakdown showing task distribution
 */
export interface VLabelBreakdown {
  v1: number; // minutes
  v2: number; // minutes
  v3: number; // minutes
}

/**
 * Single task from task breakdown
 */
export interface Task {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  estimate: number; // minutes
  assignment: string; // engineer name
  vLabel: "V1" | "V2" | "V3";
  dependencies: string[]; // task IDs
}

/**
 * Data extracted from handoff-*.md files
 */
export interface HandoffData {
  taskId: string;
  featureTitle: string;
  engineer: string;
  status: "complete" | "partial" | "failed";
  filesChanged: string[];
  selfEvaluationScores: SelfEvaluationScores;
  knownIssues: string[];
  summary: string;
  gitCommitHash?: string;
}

/**
 * Self-evaluation scores (4 criteria out of 10 each)
 */
export interface SelfEvaluationScores {
  functionality: number; // 0-10
  codeQuality: number; // 0-10
  testing: number; // 0-10
  documentation: number; // 0-10
}

/**
 * Data extracted from eval-report.md files
 */
export interface EvalReportData {
  taskId: string;
  featureTitle: string;
  evalScores: EvalScores;
  passResult: boolean;
  testEvidence: string;
  requiredFixes: string[];
  notes: string;
  evaluator: string;
  evaluatedAt: string;
}

/**
 * Evaluation scores (4 criteria out of 10 each)
 */
export interface EvalScores {
  functionality: number; // 0-10
  codeQuality: number; // 0-10
  testing: number; // 0-10
  documentation: number; // 0-10
}

/**
 * Data extracted from sprint-report.md
 */
export interface SprintReportData {
  sprintId: string;
  deploymentUrl: string;
  deploymentTime: string;
  featuresShipped: ShippedFeature[];
  featuresDropped: DroppedFeature[];
  summary: string;
}

/**
 * Feature shipped in the sprint
 */
export interface ShippedFeature {
  taskId: string;
  title: string;
  engineer: string;
  status: "shipped" | "partial";
}

/**
 * Feature dropped or deferred
 */
export interface DroppedFeature {
  taskId: string;
  title: string;
  reason: string;
}

/**
 * Parsing error with line number for debugging
 */
export interface ParsingError {
  message: string;
  lineNumber?: number;
  section?: string;
}

/**
 * Result wrapper for parsing operations
 */
export interface ParsingResult<T> {
  data: T | null;
  errors: ParsingError[];
  isValid: boolean;
}
