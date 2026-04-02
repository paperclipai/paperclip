/**
 * Parser for eval-report.md artifacts
 * Extracts QA evaluation data including scores, pass/fail result, and required fixes
 */

import type {
  EvalReportData,
  EvalScores,
  ParsingError,
  ParsingResult,
} from "../types/sprint-artifacts.js";

/**
 * Parse an evaluation report markdown document
 * Extracts task ID, feature title, scores, pass/fail determination, test evidence, and required fixes
 */
export function parseEvalReport(content: string): ParsingResult<EvalReportData> {
  const errors: ParsingError[] = [];

  try {
    // Extract basic metadata
    const taskId = extractField(content, "Task ID") || extractTaskIdFromTitle(content);
    const featureTitle =
      extractField(content, "Feature") ||
      extractField(content, "Feature Title") ||
      extractTitleFromHeading(content);
    const evaluator = extractField(content, "Evaluator") || extractField(content, "QA Engineer");
    const evaluatedAt = extractField(content, "Evaluated") || extractField(content, "Date");

    // Parse evaluation scores
    const evalScores = parseEvalScores(content);

    // Determine pass/fail (total ≥24 AND all ≥6)
    const passResult = determinePassResult(evalScores);

    // Extract test evidence
    const testEvidence = extractSection(content, "Test Evidence") || "";

    // Extract required fixes
    const requiredFixes = parseList(extractSection(content, "Required Fixes"));

    // Extract notes
    const notes = extractSection(content, "Notes") || "";

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

    // Check if evaluation scores are present
    if (!hasValidScores(evalScores)) {
      errors.push({
        message: "Evaluation scores not found or incomplete",
        section: "evaluation",
      });
    }

    const data: EvalReportData = {
      taskId,
      featureTitle,
      evalScores,
      passResult,
      testEvidence,
      requiredFixes,
      notes,
      evaluator,
      evaluatedAt,
    };

    return {
      data,
      errors,
      isValid: errors.length === 0,
    };
  } catch (error) {
    errors.push({
      message: `Unexpected error parsing eval report: ${error instanceof Error ? error.message : String(error)}`,
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
  // Try to find pattern like TASK-001, F1, FEAT-1
  const match = content.match(/(?:Task ID|ID)[:\s\-]*\[?([A-Z]+-\d+|[A-Z]\d+|FEAT-\d+)\]?/i);
  if (match) {
    return match[1];
  }
  // Try to find in eval pattern
  const evalMatch = content.match(/eval[:\s\-]*([A-Za-z0-9\-]+)/i);
  if (evalMatch) {
    return evalMatch[1];
  }
  return "";
}

/**
 * Parse evaluation scores from various table and field formats
 */
function parseEvalScores(content: string): EvalScores {
  const scores: EvalScores = {
    functionality: 0,
    codeQuality: 0,
    testing: 0,
    documentation: 0,
  };

  // Try table format first (markdown table)
  const tableMatch = content.match(
    /\|?\s*Criterion\s*\|[^|]*Score[^|]*\|[\s\S]*?\n\|[^|]*\|/i
  );
  if (tableMatch) {
    const tableContent = tableMatch[0];
    scores.functionality = extractScoreFromContent(
      tableContent,
      "functionality",
      0
    );
    scores.codeQuality = extractScoreFromContent(
      tableContent,
      "code.*quality",
      0
    );
    scores.testing = extractScoreFromContent(tableContent, "testing", 0);
    scores.documentation = extractScoreFromContent(
      tableContent,
      "documentation",
      0
    );
  }

  // Try individual field format if scores still missing
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

/**
 * Check if scores are valid (at least one score present)
 */
function hasValidScores(scores: EvalScores): boolean {
  return (
    scores.functionality > 0 ||
    scores.codeQuality > 0 ||
    scores.testing > 0 ||
    scores.documentation > 0
  );
}

/**
 * Determine pass/fail based on criteria:
 * PASS if: total >= 24 AND all scores >= 6
 */
export function determinePassResult(scores: EvalScores): boolean {
  const total = scores.functionality + scores.codeQuality + scores.testing + scores.documentation;

  // Check if total >= 24 and all individual scores >= 6
  return (
    total >= 24 &&
    scores.functionality >= 6 &&
    scores.codeQuality >= 6 &&
    scores.testing >= 6 &&
    scores.documentation >= 6
  );
}

/**
 * Parse a markdown list into an array of strings
 */
function parseList(content: string): string[] {
  if (!content) return [];

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
