import type { ToolRiskLevel } from "@paperclipai/shared";

// Reviewed against Circleback's hosted MCP tool reference on 2026-11-12:
// https://circleback.ai/docs/support/platform/circleback-mcp
// The generic classifier reads ShareMeeting, ShareFolder and SubmitFeedback as
// reads because "share" and "submit" are not write verbs. Exact names make
// additions and renames default to write until they are reviewed.
const READ_TOOLS = new Set([
  "SearchMeetings",
  "ReadMeetings",
  "GetTranscriptsForMeetings",
  "SearchTranscripts",
  "SearchActionItems",
  "SearchCalendarEvents",
  "SearchEmails",
  "FindProfiles",
  "FindCompanies",
  "ListTags",
  "ListFolders",
  "ReadFolders",
  "ListTeams",
  "SearchSupportArticles",
  // MCP Apps views: they render records the agent already selected. Changes
  // made from a card go through the write tools below.
  "DisplayMeetings",
  "DisplayActionItems",
  "DisplayCalendarEvents",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "DeleteActionItem",
  "DeleteTag",
  "DeleteFolder",
]);

export function circlebackRisk(tool: {
  name: string;
  annotations?: Record<string, unknown>;
}): ToolRiskLevel {
  const annotations = tool.annotations ?? {};
  if (annotations.destructiveHint === true || annotations.destructive === true
    || DESTRUCTIVE_TOOLS.has(tool.name)) return "destructive";
  if (annotations.readOnlyHint === false || annotations.writeHint === true) return "write";
  return READ_TOOLS.has(tool.name) ? "read" : "write";
}
