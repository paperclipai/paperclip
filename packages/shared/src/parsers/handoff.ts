/**
 * Parser for handoff-*.md artifacts
 * Extracts engineer self-evaluation and feature handoff data
 */

import type {
  HandoffData,
  SelfEvaluationScores,
  ParsingError,
  ParsingResult,
} from "../types/sprint-artifacts.js";

/**
 * Parse a handoff markdown document
 * Extracts task ID, feature title, engineer, status, files changed, self-evaluation scores, and issues
 */
export function parseHandoff(content: string): ParsingResult<HandoffData> {
  const errors: ParsingError[] = [];

  try {
    // Extract basic metadata
    const taskId = extractField(content, "Task ID") || extractTaskIdFromTitle(content);
    const featureTitle =
      extractField(content, "Feature") ||
      extractField(content, "Feature Title") ||
      extractTitleFromHeading(content);
    const engineer =
      extractField(content, "Engineer") ||
      extractField(content, "Engineer Name") ||
      extractField(content, "Developer");
    const status = parseStatus(extractField(content, "Status"));
    const filesChanged = parseFilesList(extractSection(content, "Files Changed"));
    const knownIssues = parseList(extractSection(content, "Known Issues"));
    const summary = extractSection(content, "Summary") || "";
    const gitCommitHash = extractField(content, "Git Commit") || extractField(content, "Commit Hash");

    // Parse self-evaluation scores
    const selfEvaluationScores = parseSelfEvaluationScores(content);

    // Validate required fields
    if (!taskId) {
      errors.push({
        message: "Task ID not found in document",
        section: "metadata",
      });
    }

    if (!featureTitle) {
      errors.push({
        message: "Feature title not found in document",
        section: "metadata",
      });
    }

    if (!engineer) {
      errors.push({
        message: "Engineer name not found in document",
        section: "metadata",
      });
    }

    // Check if all evaluation scores are present
    if (
      selfEvaluationScores.functionality === 0 &&
      selfEvaluationScores.codeQuality === 0 &&
      selfEvaluationScores.testing === 0 &&
      selfEvaluationScores.documentation === 0
    ) {
      errors.push({
        message: "Self-evaluation scores not found or all zero",
        section: "evaluation",
      });
    }

    const data: HandoffData = {
      taskId,
      featureTitle,
      engineer,
      status,
      filesChanged,
      selfEvaluationScores,
      knownIssues,
      summary,
      gitCommitHash,
    };

    return {
      data,
      errors,
      isValid: errors.length === 0,
    };
  } catch (error) {
    errors.push({
      message: `Unexpected error parsing handoff: ${error instanceof Error ? error.message : String(error)}`,
    });

    return {
      data: null,
      errors,
      isValid: false,
    };
  }
}

/**
 * Extract a markdown section by header name
 */
function extractSection(content: string, headerName: string): string {
  const headerRegex = new RegExp(`^#{2,4}\\s+${headerName}\\s*$`, "mi");
  const match = content.match(headerRegex);

  if (!match) {
    return "";
  }

  const startIndex = match.index! + match[0].length;
  const remainingContent = content.substring(startIndex);

  // Find the next header at the same or higher level
  const nextHeaderMatch = remainingContent.match(/^#{2,4}\s+/m);
  const endIndex = nextHeaderMatch
    ? remainingContent.indexOf(nextHeaderMatch[0])
    : remainingContent.length;

  return remainingContent.substring(0, endIndex).trim();
}

/**
 * Extract a field value (key: value format)
 */
function extractField(content: string, fieldName: string): string {
  const regex = new RegExp(`${fieldName}\\s*[:\-]\\s*(.+?)(?=\\n|$)`, "i");
  const match = content.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Extract title from document heading
 */
function extractTitleFromHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

/**
 * Extract task ID from title or content
 */
function extractTaskIdFromTitle(content: string): string {
  // Try to find pattern like TASK-001, F1, FEAT-1, or [TASK-ID]
  const match = content.match(/(?:Task ID|ID|handoff)[:\s\-]*\[?([A-Z]+-\d+|[A-Z]\d+|FEAT-\d+)\]?/i);
  if (match) {
    return match[1];
  }
  // Try to find in filename pattern if present
  const filenameMatch = content.match(/handoff[:\s\-]*([A-Za-z0-9\-]+)/i);
  if (filenameMatch) {
    return filenameMatch[1];
  }
  return "";
}

/**
 * Parse status field
 */
function parseStatus(statusValue: string): "complete" | "partial" | "failed" {
  const normalized = statusValue.toLowerCase();
  if (normalized.includes("complete") || normalized.includes("done")) return "complete";
  if (normalized.includes("partial") || normalized.includes("incomplete")) return "partial";
  if (normalized.includes("fail")) return "failed";
  return "partial";
}

/**
 * Parse files changed list
 */
function parseFilesList(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        (trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed)) &&
        trimmed.length > 2
      );
    })
    .map((line) => {
      // Remove list markers and clean up
      const cleaned = line.replace(/^\s*[-*\d.]\s+/, "").trim();
      // Extract filename if in format: `src/index.ts` or src/index.ts
      const filenameMatch = cleaned.match(/[`']?([^\s`']+)[`']?/);
      return filenameMatch ? filenameMatch[1] : cleaned;
    })
    .filter((item) => item.length > 0);
}

/**
 * Parse a markdown list into an array of strings
 */
function parseList(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed);
    })
    .map((line) => {
      // Remove list markers
      return line.replace(/^\s*[-*\d.]\s+/, "").trim();
    })
    .filter((item) => item.length > 0);
}

/**
 * Parse self-evaluation scores from various table and field formats
 */
function parseSelfEvaluationScores(content: string): SelfEvaluationScores {
  const scores: SelfEvaluationScores = {
    functionality: 0,
    codeQuality: 0,
    testing: 0,
    documentation: 0,
  };

  // Try table format first (markdown table)
  const tableMatch = content.match(
    /\|?\s*Criterion\s*\|[^|]*\|[\s\S]*?\|/i
  );
  if (tableMatch) {
    // Extract table content
    const tableContent = tableMatch[0];
    scores.functionality = extractScoreFromContent(
      tableContent,
      "functionality",
      scores.functionality
    );
    scores.codeQuality = extractScoreFromContent(
      tableContent,
      "code.*quality",
      scores.codeQuality
    );
    scores.testing = extractScoreFromContent(tableContent, "testing", scores.testing);
    scores.documentation = extractScoreFromContent(
      tableContent,
      "documentation",
      scores.documentation
    );
  }

  // Try individual field format
  if (scores.functionality === 0) {
    scores.functionality = parseScoreField(content, "Functionality");
  }
  if (scores.codeQuality === 0) {
    scores.codeQuality = parseScoreField(content, "Code Quality");
  }
  if (scores.testing === 0) {
    scores.testing = parseScoreField(content, "Testing");
  }
  if (scores.documentation === 0) {
    scores.documentation = parseScoreField(content, "Documentation");
  }

  return scores;
}

/**
 * Extract a single score value from content using regex
 */
function extractScoreFromContent(
  content: string,
  pattern: string,
  defaultValue: number
): number {
  const regex = new RegExp(`${pattern}[^\\d]*([\\d]{1,2})`, "i");
  const match = content.match(regex);
  if (match && match[1]) {
    const score = parseInt(match[1], 10);
    return score >= 0 && score <= 10 ? score : defaultValue;
  }
  return defaultValue;
}

/**
 * Parse score from field like "Functionality: 8"
 */
function parseScoreField(content: string, fieldName: string): number {
  const regex = new RegExp(`${fieldName}[^\\d]*([\\d]{1,2})`, "i");
  const match = content.match(regex);
  if (match && match[1]) {
    const score = parseInt(match[1], 10);
    return score >= 0 && score <= 10 ? score : 0;
  }
  return 0;
}
