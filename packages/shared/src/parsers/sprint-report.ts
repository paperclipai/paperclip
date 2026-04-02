/**
 * Parser for sprint-report.md artifacts
 * Extracts sprint deployment data and feature shipping information
 */

import type {
  SprintReportData,
  ShippedFeature,
  DroppedFeature,
  ParsingError,
  ParsingResult,
} from "../types/sprint-artifacts.js";

/**
 * Parse a sprint report markdown document
 * Extracts sprint ID, deployment URL, features shipped, and features dropped
 */
export function parseSprintReport(content: string): ParsingResult<SprintReportData> {
  const errors: ParsingError[] = [];

  try {
    // Extract basic metadata
    const sprintId = extractField(content, "Sprint ID") || extractSprintIdFromTitle(content);
    const deploymentUrl = extractField(content, "Deployment URL") || extractField(content, "URL");
    const deploymentTime = extractField(content, "Deployment Time") || extractField(content, "Deployed");

    // Extract features shipped
    const featuresShipped = parseFeaturesTable(
      content,
      "Features Shipped"
    ) || parseFeaturesTable(content, "Deployed Features");

    // Extract features dropped
    const featuresDropped = parseDroppedFeaturesTable(content) || [];

    // Extract summary
    const summary = extractSection(content, "Summary") || "";

    // Validate required fields
    if (!sprintId) {
      errors.push({
        message: "Sprint ID not found in document",
        section: "metadata",
      });
    }

    if (!deploymentUrl) {
      errors.push({
        message: "Deployment URL not found in document",
        section: "metadata",
      });
    }

    const data: SprintReportData = {
      sprintId,
      deploymentUrl,
      deploymentTime,
      featuresShipped,
      featuresDropped,
      summary,
    };

    return {
      data,
      errors,
      isValid: errors.length === 0,
    };
  } catch (error) {
    errors.push({
      message: `Unexpected error parsing sprint report: ${error instanceof Error ? error.message : String(error)}`,
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
 * Extract sprint ID from title or content
 */
function extractSprintIdFromTitle(content: string): string {
  // Try to find pattern like sprint-2024-03-31 or SPRINT-001
  const match = content.match(
    /sprint[:\s\-]*([A-Za-z0-9\-]+)/i
  );
  if (match) {
    return match[1];
  }
  // Try title format
  const titleMatch = content.match(/^#\s+Sprint\s+([A-Za-z0-9\-]+)/m);
  if (titleMatch) {
    return titleMatch[1];
  }
  return "";
}

/**
 * Parse features from a shipped features table
 */
function parseFeaturesTable(
  content: string,
  sectionName: string
): ShippedFeature[] {
  const section = extractSection(content, sectionName);
  if (!section) {
    return [];
  }

  return parseShippedFeaturesFromContent(section);
}

/**
 * Parse shipped features from table content
 */
function parseShippedFeaturesFromContent(content: string): ShippedFeature[] {
  const features: ShippedFeature[] = [];
  const lines = content.split("\n");

  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Detect table header
    if (trimmed.startsWith("|") && !trimmed.includes("---")) {
      inTable = true;
      headers = parseTableRow(line);
      continue;
    }

    // Skip separator rows
    if (trimmed.includes("---")) {
      continue;
    }

    // Parse data rows
    if (trimmed.startsWith("|") && inTable) {
      const row = parseTableRow(line);
      const feature = parseShippedFeatureRow(row, headers);
      if (feature) {
        features.push(feature);
      }
    }

    // End of table
    if (inTable && !trimmed.startsWith("|") && trimmed.length > 0) {
      inTable = false;
    }
  }

  return features;
}

/**
 * Parse a feature from a shipped features table row
 */
function parseShippedFeatureRow(row: string[], headers: string[]): ShippedFeature | null {
  let taskId = "";
  let title = "";
  let engineer = "";
  let status: "shipped" | "partial" = "shipped";

  for (let i = 0; i < headers.length && i < row.length; i++) {
    const header = headers[i].toLowerCase();
    const value = row[i];

    if (header.includes("task") || header.includes("id") || header.includes("feature id")) {
      taskId = value;
    } else if (header.includes("title") || header.includes("feature")) {
      title = value;
    } else if (header.includes("engineer") || header.includes("owner") || header.includes("developer")) {
      engineer = value;
    } else if (header.includes("status")) {
      status = value.toLowerCase().includes("partial") ? "partial" : "shipped";
    }
  }

  if (taskId && title) {
    return { taskId, title, engineer, status };
  }

  return null;
}

/**
 * Parse dropped features from content
 */
function parseDroppedFeaturesTable(content: string): DroppedFeature[] {
  const section =
    extractSection(content, "Features Dropped") ||
    extractSection(content, "Deferred Features") ||
    extractSection(content, "Not Shipped");

  if (!section) {
    return [];
  }

  return parseDroppedFeaturesFromContent(section);
}

/**
 * Parse dropped features from table or list content
 */
function parseDroppedFeaturesFromContent(content: string): DroppedFeature[] {
  const features: DroppedFeature[] = [];
  const lines = content.split("\n");

  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Detect table header
    if (trimmed.startsWith("|") && !trimmed.includes("---")) {
      inTable = true;
      headers = parseTableRow(line);
      continue;
    }

    // Skip separator rows
    if (trimmed.includes("---")) {
      continue;
    }

    // Parse table data rows
    if (trimmed.startsWith("|") && inTable) {
      const row = parseTableRow(line);
      const feature = parseDroppedFeatureRow(row, headers);
      if (feature) {
        features.push(feature);
      }
    }

    // Parse list format (- TASK-ID: Title — Reason)
    if ((trimmed.startsWith("-") || trimmed.startsWith("*")) && !inTable) {
      const feature = parseDroppedFeatureFromListItem(trimmed);
      if (feature) {
        features.push(feature);
      }
    }

    // End of table
    if (inTable && !trimmed.startsWith("|") && trimmed.length > 0) {
      inTable = false;
    }
  }

  return features;
}

/**
 * Parse a dropped feature from a table row
 */
function parseDroppedFeatureRow(row: string[], headers: string[]): DroppedFeature | null {
  let taskId = "";
  let title = "";
  let reason = "";

  for (let i = 0; i < headers.length && i < row.length; i++) {
    const header = headers[i].toLowerCase();
    const value = row[i];

    if (header.includes("task") || header.includes("id") || header.includes("feature id")) {
      taskId = value;
    } else if (header.includes("title") || header.includes("feature")) {
      title = value;
    } else if (header.includes("reason") || header.includes("why")) {
      reason = value;
    }
  }

  if (taskId && title) {
    return { taskId, title, reason };
  }

  return null;
}

/**
 * Parse a dropped feature from a list item like "- TASK-ID: Title — Reason"
 */
function parseDroppedFeatureFromListItem(item: string): DroppedFeature | null {
  // Remove list marker
  const content = item.replace(/^[-*]\s+/, "").trim();

  // Try pattern: ID: Title — Reason
  const dashMatch = content.match(/^([A-Z0-9\-]+)\s*[:\-]\s*(.+?)\s*[—\-]\s*(.+)$/);
  if (dashMatch) {
    return {
      taskId: dashMatch[1],
      title: dashMatch[2],
      reason: dashMatch[3],
    };
  }

  // Try pattern: ID: Title (Reason)
  const parenMatch = content.match(/^([A-Z0-9\-]+)\s*[:\-]\s*(.+?)\s*\((.+?)\)$/);
  if (parenMatch) {
    return {
      taskId: parenMatch[1],
      title: parenMatch[2],
      reason: parenMatch[3],
    };
  }

  return null;
}

/**
 * Parse a table row into cells
 */
function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1) // Remove leading and trailing empty cells
    .map((cell) => cell.trim());
}
