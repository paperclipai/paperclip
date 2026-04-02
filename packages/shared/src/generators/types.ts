/**
 * TypeScript interfaces for release generation
 * Defines the structure of changelog entries, PR comments, and release metadata
 */

/**
 * A single changelog entry for a release
 */
export interface ChangelogEntry {
  version: string; // CalVer format: vYYYY.DDD.P
  date: string; // ISO 8601 format
  summary: string; // Summary from sprint brief
  featuresShipped: ChangelogFeature[];
  featuresDropped: DroppedFeatureEntry[];
  breakingChanges: BreakingChange[];
  contributors: string[]; // Engineer names
  sprintId: string;
  markdown: string; // Full markdown representation
}

/**
 * A feature shipped in a release
 */
export interface ChangelogFeature {
  title: string;
  description: string;
  qaScore: number; // 0-10
  engineer: string;
  taskId: string;
}

/**
 * A feature dropped from a release
 */
export interface DroppedFeatureEntry {
  title: string;
  reason: string;
  taskId: string;
}

/**
 * Breaking change entry
 */
export interface BreakingChange {
  description: string;
  migration: string;
}

/**
 * Data for generating a PR comment
 */
export interface PRCommentData {
  header: string;
  featuresTable: string; // Formatted markdown table
  droppedFeaturesSection: string;
  paperclipLink: string;
  deploymentUrl: string;
  summary: string;
  markdown: string; // Full markdown representation
}

/**
 * Release metadata for updating Paperclip issue
 */
export interface ReleaseMetadata {
  released: boolean;
  releaseVersion: string; // vYYYY.DDD.P
  releaseUrl?: string; // Link to release on GitHub
  changelogPath?: string; // Anchor to changelog section
  releasedAt?: string; // ISO 8601 timestamp
}

/**
 * Result of release generation orchestration
 */
export interface ReleaseResult {
  success: boolean;
  changelogPath: string;
  changelogEntry: ChangelogEntry;
  prCommentUrl?: string;
  paperclipStatus: {
    updated: boolean;
    issueId: string;
    error?: string;
  };
  errors: string[];
}

/**
 * Artifact data aggregating all parsed artifacts
 */
export interface ArtifactData {
  sprintPlan: any; // SprintPlanData from parsers
  taskBreakdown: any; // Array of Task
  handoffs: any[]; // Array of HandoffData
  evals: any[]; // Array of EvalReportData
  sprintReport: any; // SprintReportData from parsers
}

/**
 * Configuration for release generation
 */
export interface ReleaseGeneratorOptions {
  paperclip?: {
    client: any;
    issueId: string;
  };
  github?: {
    client: any;
    prUrl: string;
    token: string;
  };
  dryRun?: boolean;
  baseUrl?: string; // For generating links
}
