/**
 * Changelog entry generator
 * Transforms parsed sprint data into CHANGELOG.md entries
 */

import type {
  ChangelogEntry,
  ChangelogFeature,
  DroppedFeatureEntry,
  ArtifactData,
} from "./types.js";

/**
 * Generate a changelog entry from sprint data and artifacts
 * Creates a formatted markdown entry ready for inclusion in CHANGELOG.md
 */
export function generateChangelogEntry(
  artifactData: ArtifactData
): ChangelogEntry {
  const sprintReport = artifactData.sprintReport;
  const sprintPlan = artifactData.sprintPlan;
  const evals = artifactData.evals || [];
  const handoffs = artifactData.handoffs || [];

  // Generate version in CalVer format: vYYYY.DDD.P
  const version = generateCalVerVersion(sprintReport.sprintId);

  // Generate date from sprint report or current date
  const date = sprintReport.deploymentTime
    ? new Date(sprintReport.deploymentTime).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  // Extract summary from sprint brief
  const summary = sprintPlan?.brief || sprintReport.summary || "";

  // Build featured shipped list with QA scores
  const featuresShipped = buildShippedFeatures(
    sprintReport.featuresShipped || [],
    evals,
    handoffs
  );

  // Build dropped features list with reasons
  const featuresDropped = sprintReport.featuresDropped?.map(
    (feature: any) => ({
      title: feature.title,
      reason: feature.reason || "Not started",
      taskId: feature.taskId,
    })
  ) || [];

  // Extract breaking changes (if any)
  const breakingChanges = extractBreakingChanges(sprintPlan?.dataModel || "");

  // Extract contributors (engineer names)
  const contributors = Array.from(
    new Set([
      ...featuresShipped.map((f) => f.engineer),
      ...handoffs.map((h: any) => h.engineer),
    ])
  ).filter(Boolean);

  // Generate markdown
  const markdown = renderChangelogMarkdown({
    version,
    date,
    summary,
    featuresShipped,
    featuresDropped,
    breakingChanges,
    contributors,
  });

  return {
    version,
    date,
    summary,
    featuresShipped,
    featuresDropped,
    breakingChanges,
    contributors,
    sprintId: sprintReport.sprintId,
    markdown,
  };
}

/**
 * Generate CalVer version string: vYYYY.DDD.P
 * YYYY = year, DDD = day of year, P = patch number
 */
function generateCalVerVersion(sprintId: string): string {
  // Extract date from sprint ID if available (format: YYYY-MM-DD-...)
  const dateMatch = sprintId.match(/(\d{4})-(\d{2})-(\d{2})/);

  if (dateMatch) {
    const [, year, month, day] = dateMatch;
    const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
    const dayOfYear = Math.floor(
      (date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) /
        86400000
    );
    return `v${year}.${String(dayOfYear).padStart(3, "0")}.0`;
  }

  // Fallback: use current date
  const now = new Date();
  const year = now.getFullYear();
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(year, 0, 0).getTime()) / 86400000
  );
  return `v${year}.${String(dayOfYear).padStart(3, "0")}.0`;
}

/**
 * Build shipped features list with QA scores
 */
function buildShippedFeatures(
  shippedFeatures: any[],
  evals: any[],
  handoffs: any[]
): ChangelogFeature[] {
  return shippedFeatures.map((feature: any) => {
    // Find corresponding eval report
    const evalReport = evals.find((e: any) => e.taskId === feature.taskId);
    const handoff = handoffs.find((h: any) => h.taskId === feature.taskId);

    // Calculate QA score from eval report
    let qaScore = 8; // Default safe score
    if (evalReport?.evalScores) {
      // Average of all eval scores
      const scores = [
        evalReport.evalScores.functionality,
        evalReport.evalScores.codeQuality,
        evalReport.evalScores.testing,
        evalReport.evalScores.documentation,
      ];
      qaScore = Math.round(
        scores.reduce((a: number, b: number) => a + b, 0) / scores.length
      );
    } else if (handoff?.selfEvaluationScores) {
      // Use self-eval as fallback
      const scores = [
        handoff.selfEvaluationScores.functionality,
        handoff.selfEvaluationScores.codeQuality,
        handoff.selfEvaluationScores.testing,
        handoff.selfEvaluationScores.documentation,
      ];
      qaScore = Math.round(
        scores.reduce((a: number, b: number) => a + b, 0) / scores.length
      );
    }

    return {
      title: feature.title,
      description: handoff?.summary || evalReport?.notes || "",
      qaScore: Math.min(10, Math.max(0, qaScore)), // Clamp 0-10
      engineer: feature.engineer || handoff?.engineer || "Unknown",
      taskId: feature.taskId,
    };
  });
}

/**
 * Extract breaking changes from data model or release notes
 */
function extractBreakingChanges(dataModel: string): Array<{
  description: string;
  migration: string;
}> {
  // Look for breaking change markers in data model
  const breakingChanges = [];

  // This is a simplified implementation
  // In production, would parse more structured breaking change data
  if (dataModel.includes("BREAKING") || dataModel.includes("breaking")) {
    breakingChanges.push({
      description: "Data model changes require migration",
      migration: "See migration guide in release notes",
    });
  }

  return breakingChanges;
}

/**
 * Render changelog entry as markdown
 */
function renderChangelogMarkdown(entry: {
  version: string;
  date: string;
  summary: string;
  featuresShipped: ChangelogFeature[];
  featuresDropped: DroppedFeatureEntry[];
  breakingChanges: Array<{ description: string; migration: string }>;
  contributors: string[];
}): string {
  let markdown = `## ${entry.version} (${entry.date})\n\n`;

  // Summary section
  if (entry.summary) {
    markdown += `### Summary\n\n${entry.summary}\n\n`;
  }

  // Features shipped section
  if (entry.featuresShipped.length > 0) {
    markdown += `### Features\n\n`;
    entry.featuresShipped.forEach((feature) => {
      markdown += `- **${feature.title}** (QA: ${feature.qaScore}/10) - ${feature.engineer}\n`;
      if (feature.description) {
        markdown += `  ${feature.description}\n`;
      }
    });
    markdown += "\n";
  }

  // Breaking changes section
  if (entry.breakingChanges.length > 0) {
    markdown += `### Breaking Changes\n\n`;
    entry.breakingChanges.forEach((change) => {
      markdown += `- **${change.description}**\n`;
      markdown += `  Migration: ${change.migration}\n`;
    });
    markdown += "\n";
  }

  // Features dropped section
  if (entry.featuresDropped.length > 0) {
    markdown += `### Deferred\n\n`;
    entry.featuresDropped.forEach((feature) => {
      markdown += `- ${feature.title}: ${feature.reason}\n`;
    });
    markdown += "\n";
  }

  // Contributors section
  if (entry.contributors.length > 0) {
    markdown += `### Contributors\n\n`;
    markdown += entry.contributors.map((c) => `- ${c}`).join("\n");
    markdown += "\n";
  }

  return markdown;
}
