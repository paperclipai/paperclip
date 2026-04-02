/**
 * Parser for task-breakdown.md artifacts
 * Extracts structured task data including ID, title, description, estimates, assignments, and dependencies
 */

import type { Task, ParsingError, ParsingResult } from "../types/sprint-artifacts.js";

/**
 * Parse a task breakdown markdown document
 * Returns array of Task objects extracted from tables or lists
 */
export function parseTaskBreakdown(content: string): ParsingResult<Task[]> {
  const errors: ParsingError[] = [];
  const tasks: Task[] = [];

  try {
    // Try parsing as markdown table first
    const tasksFromTable = parseTaskTable(content);
    if (tasksFromTable.length > 0) {
      return {
        data: tasksFromTable,
        errors,
        isValid: true,
      };
    }

    // Fall back to parsing as list
    const tasksFromList = parseTaskList(content);

    if (tasksFromList.length === 0) {
      errors.push({
        message: "No tasks found in document. Expected table or list format.",
        section: "tasks",
      });
    }

    return {
      data: tasksFromList,
      errors,
      isValid: tasksFromList.length > 0,
    };
  } catch (error) {
    errors.push({
      message: `Unexpected error parsing task breakdown: ${error instanceof Error ? error.message : String(error)}`,
    });

    return {
      data: null,
      errors,
      isValid: false,
    };
  }
}

/**
 * Parse tasks from a markdown table format
 */
function parseTaskTable(content: string): Task[] {
  const tasks: Task[] = [];

  // Look for markdown tables
  const tableRegex = /^\|(.+)\|$/gm;
  const lines = content.split("\n");
  let tableStart = -1;
  let headers: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect table header (first non-separator table line)
    if (line.trim().startsWith("|") && !line.includes("---")) {
      if (tableStart === -1) {
        tableStart = i;
        headers = parseTableRow(line);
      }
      continue;
    }

    // Skip separator rows
    if (line.includes("---")) {
      continue;
    }

    // Parse data rows
    if (line.trim().startsWith("|") && tableStart !== -1) {
      const row = parseTableRow(line);
      const task = parseTaskRow(row, headers);
      if (task) {
        tasks.push(task);
      }
    }

    // End of table
    if (tableStart !== -1 && !line.trim().startsWith("|") && line.trim().length > 0) {
      tableStart = -1;
    }
  }

  return tasks;
}

/**
 * Parse a single table row into cells
 */
function parseTableRow(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1) // Remove leading and trailing empty cells
    .map((cell) => cell.trim());
}

/**
 * Parse a task from a table row using headers
 */
function parseTaskRow(row: string[], headers: string[]): Task | null {
  const task: Partial<Task> = {};

  for (let i = 0; i < headers.length && i < row.length; i++) {
    const header = headers[i].toLowerCase();
    const value = row[i];

    if (header.includes("id") || header.includes("task id")) {
      task.id = value;
    } else if (header.includes("title")) {
      task.title = value;
    } else if (header.includes("description")) {
      task.description = value;
    } else if (
      header.includes("acceptance") ||
      header.includes("criteria") ||
      header.includes("ac")
    ) {
      task.acceptanceCriteria = parseListField(value);
    } else if (header.includes("estimate") || header.includes("time")) {
      task.estimate = parseInt(value, 10) || 0;
    } else if (
      header.includes("assign") ||
      header.includes("owner") ||
      header.includes("engineer")
    ) {
      task.assignment = value;
    } else if (header.includes("v-label") || header.includes("label")) {
      task.vLabel = normalizeVLabel(value);
    } else if (header.includes("depend") || header.includes("deps")) {
      task.dependencies = parseListField(value);
    }
  }

  // Return task only if it has required fields
  if (task.id && task.title) {
    return {
      id: task.id,
      title: task.title,
      description: task.description || "",
      acceptanceCriteria: task.acceptanceCriteria || [],
      estimate: task.estimate || 0,
      assignment: task.assignment || "",
      vLabel: task.vLabel || "V1",
      dependencies: task.dependencies || [],
    };
  }

  return null;
}

/**
 * Parse tasks from a list format (not a table)
 */
function parseTaskList(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split("\n");

  let currentTask: Partial<Task> | null = null;
  let currentField = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect task header (### Task or ## Task or - Task ID:)
    const taskMatch = trimmed.match(/^[-\*]\s+(.+?)(?:\s*\(ID:\s*(.+?)\))?$/);
    const taskHeadingMatch = trimmed.match(/^#{2,3}\s+(.+)/);

    if (taskMatch || taskHeadingMatch) {
      if (currentTask && currentTask.id && currentTask.title) {
        tasks.push(currentTask as Task);
      }

      const taskTitle = taskMatch ? taskMatch[1] : taskHeadingMatch?.[1] || "";
      const taskId = taskMatch?.[2] || extractTaskId(taskTitle);

      currentTask = {
        id: taskId,
        title: taskTitle.replace(/\s*\(ID:.+?\)/, "").trim(),
        description: "",
        acceptanceCriteria: [],
        estimate: 0,
        assignment: "",
        vLabel: "V1",
        dependencies: [],
      };
      currentField = "";
      continue;
    }

    if (!currentTask) {
      continue;
    }

    // Parse task properties
    if (trimmed.toLowerCase().startsWith("description:")) {
      currentTask.description = trimmed.substring("description:".length).trim();
      currentField = "description";
    } else if (
      trimmed.toLowerCase().startsWith("acceptance") ||
      trimmed.toLowerCase().startsWith("criteria:")
    ) {
      currentField = "acceptanceCriteria";
      const content = trimmed.split(":").slice(1).join(":").trim();
      if (content) {
        currentTask.acceptanceCriteria = parseListField(content);
      }
    } else if (
      trimmed.toLowerCase().startsWith("estimate:") ||
      trimmed.toLowerCase().startsWith("time:")
    ) {
      const match = trimmed.match(/\d+/);
      if (match) {
        currentTask.estimate = parseInt(match[0], 10);
      }
      currentField = "";
    } else if (
      trimmed.toLowerCase().startsWith("assign") ||
      trimmed.toLowerCase().startsWith("owner:")
    ) {
      currentTask.assignment = trimmed.split(":").slice(1).join(":").trim();
      currentField = "";
    } else if (
      trimmed.toLowerCase().startsWith("v-label:") ||
      trimmed.toLowerCase().startsWith("label:")
    ) {
      const labelValue = trimmed.split(":")[1].trim();
      currentTask.vLabel = normalizeVLabel(labelValue);
      currentField = "";
    } else if (
      trimmed.toLowerCase().startsWith("depend") ||
      trimmed.toLowerCase().startsWith("deps:")
    ) {
      currentField = "dependencies";
      const content = trimmed.split(":").slice(1).join(":").trim();
      if (content) {
        currentTask.dependencies = parseListField(content);
      }
    } else if ((trimmed.startsWith("-") || trimmed.startsWith("*")) && currentField === "acceptanceCriteria") {
      // Continuation of acceptance criteria list
      currentTask.acceptanceCriteria?.push(trimmed.substring(1).trim());
    } else if ((trimmed.startsWith("-") || trimmed.startsWith("*")) && currentField === "dependencies") {
      // Continuation of dependencies list
      currentTask.dependencies?.push(trimmed.substring(1).trim());
    }
  }

  // Add last task
  if (currentTask && currentTask.id && currentTask.title) {
    tasks.push(currentTask as Task);
  }

  return tasks;
}

/**
 * Parse a field that contains a list (comma-separated or markdown list)
 */
function parseListField(content: string): string[] {
  if (!content) return [];

  // Try markdown list format first
  if (content.includes("\n")) {
    return content
      .split("\n")
      .filter((line) => line.trim().startsWith("-") || line.trim().startsWith("*"))
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((item) => item.length > 0);
  }

  // Fall back to comma-separated
  return content
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Normalize V-label to standard format
 */
function normalizeVLabel(value: string): "V1" | "V2" | "V3" {
  const normalized = value.toUpperCase();
  if (normalized.includes("V1")) return "V1";
  if (normalized.includes("V2")) return "V2";
  if (normalized.includes("V3")) return "V3";
  return "V1";
}

/**
 * Extract task ID from title string if not explicitly provided
 */
function extractTaskId(title: string): string {
  // Try to find pattern like TASK-001, F1, FEAT-1
  const match = title.match(/([A-Z]+-\d+|[A-Z]\d+|FEAT-\d+)/);
  if (match) {
    return match[1];
  }
  // Default: generate from title
  return title
    .substring(0, 3)
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
}
