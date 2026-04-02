/**
 * Parser for sprint-plan.md artifacts
 * Extracts sprint plan data including brief, product spec, tech stack, and V-label breakdown
 */

import type {
  SprintPlanData,
  VLabelBreakdown,
  ParsingError,
  ParsingResult,
} from "../types/sprint-artifacts.js";

/**
 * Parse a sprint plan markdown document
 * Extracts sprint ID, brief, product name, target user, primary flow, data model, tech stack, and risk assessment
 */
export function parseSprintPlan(content: string): ParsingResult<SprintPlanData> {
  const errors: ParsingError[] = [];
  let lineNumber = 0;

  try {
    const lines = content.split("\n");

    // Extract Sprint ID
    const sprintIdMatch = content.match(
      /^#\s+Sprint\s+([A-Za-z0-9\-]+)/m
    );
    const sprintId = sprintIdMatch?.[1] || "unknown";

    // Extract Brief section
    const briefMatch = extractSection(content, "Brief", 3);
    const brief = briefMatch || "";

    // Extract Product section
    const productMatch = extractSection(content, "Product");
    const productName =
      extractField(productMatch, "Name") || extractField(productMatch, "name") || "";
    const targetUser =
      extractField(productMatch, "Target User") || extractField(productMatch, "target user") || "";
    const primaryFlow =
      extractField(productMatch, "Primary Flow") || extractField(productMatch, "primary flow") || "";

    // Extract Data Model section
    const dataModelMatch = extractSection(content, "Data Model");
    const dataModel = dataModelMatch || "";

    // Extract Tech Stack section
    const techStackMatch = extractSection(content, "Tech Stack");
    const techStack = techStackMatch || "";

    // Extract V-Label Breakdown
    const vLabelBreakdown = parseVLabelBreakdown(content);

    // Extract Risk Assessment section
    const riskMatch = extractSection(content, "Risk Assessment");
    const riskAssessment = parseList(riskMatch || "");

    // Validate required fields
    if (!sprintId || sprintId === "unknown") {
      errors.push({
        message: "Sprint ID not found in document heading",
        section: "heading",
      });
    }

    if (!brief) {
      errors.push({
        message: "Brief section not found or empty",
        section: "Brief",
      });
    }

    if (!productName) {
      errors.push({
        message: "Product name not found",
        section: "Product",
      });
    }

    const data: SprintPlanData = {
      sprintId,
      brief,
      productName,
      targetUser,
      primaryFlow,
      dataModel,
      techStack,
      vLabelBreakdown,
      riskAssessment,
    };

    return {
      data,
      errors,
      isValid: errors.length === 0,
    };
  } catch (error) {
    errors.push({
      message: `Unexpected error parsing sprint plan: ${error instanceof Error ? error.message : String(error)}`,
      lineNumber,
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
 * Handles both ## and ### headers
 */
function extractSection(content: string, headerName: string, lines?: number): string {
  // Match headers with various formats
  const headerRegex = new RegExp(
    `^#+\\s+${headerName}\\s*$`,
    "mi"
  );
  const match = content.match(headerRegex);

  if (!match) {
    return "";
  }

  const startIndex = match.index! + match[0].length;
  const remainingContent = content.substring(startIndex);

  // Find the next header at the same or higher level
  const nextHeaderMatch = remainingContent.match(/^#+\s+/m);
  const endIndex = nextHeaderMatch ? remainingContent.indexOf(nextHeaderMatch[0]) : remainingContent.length;

  let section = remainingContent.substring(0, endIndex).trim();

  // Limit to specified number of lines if provided
  if (lines) {
    section = section.split("\n").slice(0, lines).join("\n");
  }

  return section;
}

/**
 * Extract a field value from a section (key: value format)
 */
function extractField(section: string, fieldName: string): string {
  const regex = new RegExp(`${fieldName}\\s*[:\-]\\s*(.+?)(?=\\n|$)`, "i");
  const match = section.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Parse a markdown list into an array of strings
 */
function parseList(content: string): string[] {
  const items = content
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

  return items;
}

/**
 * Parse the V-Label breakdown table or list
 */
function parseVLabelBreakdown(content: string): VLabelBreakdown {
  const breakdown: VLabelBreakdown = { v1: 0, v2: 0, v3: 0 };

  // Look for V-Label breakdown table or section
  const vLabelMatch = extractSection(content, "V-Label Breakdown");

  if (!vLabelMatch) {
    return breakdown;
  }

  // Try to match table format: | V1 | 100 |
  const v1Match = vLabelMatch.match(/[Vv]1[:\s|]*(\d+)/);
  const v2Match = vLabelMatch.match(/[Vv]2[:\s|]*(\d+)/);
  const v3Match = vLabelMatch.match(/[Vv]3[:\s|]*(\d+)/);

  if (v1Match) breakdown.v1 = parseInt(v1Match[1], 10);
  if (v2Match) breakdown.v2 = parseInt(v2Match[1], 10);
  if (v3Match) breakdown.v3 = parseInt(v3Match[1], 10);

  return breakdown;
}
