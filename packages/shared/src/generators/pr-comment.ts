/**
 * GitHub PR comment generator
 * Transforms sprint data into GitHub PR comments with features table and summary
 */

import type { ArtifactData, PRCommentData } from "./types.js";

/**
 * Generate a GitHub PR comment from sprint data
 * Output stays under 5000 characters (GitHub comment limit)
 */
export function generatePRComment(
  artifactData: ArtifactData,
  options?: { paperclipIssueId?: string; deploymentUrl?: string }
): PRCommentData {
  const sprintReport = artifactData.sprintReport;
  const sprintPlan = artifactData.sprintPlan;
  const evals = artifactData.evals || [];
  const handoffs = artifactData.handoffs || [];

  // Generate version
  const version = generateCalVerVersionForComment(sprintReport.sprintId);

  // Build feature table
  const featuresTable = buildFeaturesTable(
    sprintReport.featuresShipped || [],
    evals,
    handoffs
  );

  // Build dropped features section
  const droppedFeaturesSection = buildDroppedFeaturesSection(
    sprintReport.featuresDropped || []
  );

  // Generate summary line
  const summary = generateFeatureSummary(sprintReport.featuresShipped || []);

  // Generate Paperclip link
  const paperclipLink = options?.paperclipIssueId
    ? `[Paperclip Sprint Issue](https://paperclip.ai/issues/${options.paperclipIssueId})`
    : "";

  // Deployment URL
  const deploymentUrl = options?.deploymentUrl || sprintReport.deploymentUrl || "";

  // Build markdown
  const markdown = renderPRCommentMarkdown({
    version,
    featuresTable,
    droppedFeaturesSection,
    paperclipLink,
    deploymentUrl,
    summary,
    sprintPlan,
  });

  return {
    header: `🚀 Release ${version} shipped!`,
    featuresTable,
    droppedFeaturesSection,
    paperclipLink,
    deploymentUrl,
    summary,
    markdown,
  };
}

/**
 * Generate CalVer version string for comments
 */
function generateCalVerVersionForComment(sprintId: string): string {
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

  const now = new Date();
  const year = now.getFullYear();
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(year, 0, 0).getTime()) / 86400000
  );
  return `v${year}.${String(dayOfYear).padStart(3, "0")}.0`;
}

/**
 * Build markdown table of shipped features
 * Format: Feature | QA Score | Engineer
 */
function buildFeaturesTable(
  shippedFeatures: any[],
  evals: any[],
  handoffs: any[]
): string {
  if (!shippedFeatures || shippedFeatures.length === 0) {
    return "No features shipped.";
  }

  let table = "| Feature | QA Score | Engineer |\n";
  table += "|---------|----------|----------|\n";

  shippedFeatures.forEach((feature: any) => {
    const evalReport = evals.find((e: any) => e.taskId === feature.taskId);
    const handoff = handoffs.find((h: any) => h.taskId === feature.taskId);

    let qaScore = 8;
    if (evalReport?.evalScores) {
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

    const engineer = feature.engineer || handoff?.engineer || "Unknown";
    const title = feature.title || "Untitled";

    // Ensure score is 0-10
    const score = Math.min(10, Math.max(0, qaScore));

    // Add score emoji for visual feedback
    const emoji =
      score >= 9
        ? "✅"
        : score >= 7
          ? "🟢"
          : score >= 5
            ? "🟡"
            : "🔴";

    table += `| ${title} | ${emoji} ${score}/10 | ${engineer} |\n`;
  });

  return table;
}

/**
 * Build dropped features section
 */
function buildDroppedFeaturesSection(droppedFeatures: any[]): string {
  if (!droppedFeatures || droppedFeatures.length === 0) {
    return "";
  }

  let section = "#### Deferred\n\n";
  droppedFeatures.forEach((feature: any) => {
    section += `- ${feature.title}: ${feature.reason || "Not started"}\n`;
  });

  return section;
}

/**
 * Generate one-liner summary of shipped features
 */
function generateFeatureSummary(shippedFeatures: any[]): string {
  if (!shippedFeatures || shippedFeatures.length === 0) {
    return "No features shipped this sprint.";
  }

  const count = shippedFeatures.length;
  const titles = shippedFeatures.slice(0, 3).map((f: any) => f.title);

  if (count === 1) {
    return `Shipped: ${titles[0]}`;
  } else if (count === 2) {
    return `Shipped: ${titles.join(" and ")}`;
  } else if (count === 3) {
    return `Shipped: ${titles.join(", ")}`;
  } else {
    return `Shipped: ${titles.join(", ")} + ${count - 3} more`;
  }
}

/**
 * Render PR comment as markdown
 * Keeps output under 5000 characters
 */
function renderPRCommentMarkdown(options: {
  version: string;
  featuresTable: string;
  droppedFeaturesSection: string;
  paperclipLink: string;
  deploymentUrl: string;
  summary: string;
  sprintPlan: any;
}): string {
  let markdown = `## 🚀 Release ${options.version} Shipped!\n\n`;

  // Summary
  if (options.sprintPlan?.brief) {
    markdown += `**Summary:** ${options.sprintPlan.brief}\n\n`;
  }

  // Features shipped table
  markdown += `### Features Shipped\n\n${options.featuresTable}\n\n`;

  // Dropped features
  if (options.droppedFeaturesSection) {
    markdown += `### Deferred\n\n${options.droppedFeaturesSection}\n`;
  }

  // Links section
  let linksSection = "### Links\n\n";

  if (options.deploymentUrl) {
    linksSection += `- **Deployment:** ${options.deploymentUrl}\n`;
  }

  if (options.paperclipLink) {
    linksSection += `- **Paperclip Sprint:** ${options.paperclipLink}\n`;
  }

  if (linksSection !== "### Links\n\n") {
    markdown += linksSection;
  }

  // Ensure we stay under 5000 chars
  if (markdown.length > 4900) {
    // Truncate features table if needed
    const tableEnd = markdown.indexOf("\n\n", 200);
    if (tableEnd > 0) {
      markdown = markdown.substring(0, tableEnd) + "\n\n*(truncated)*\n";
    }
  }

  return markdown;
}
