import { PaperclipApiClient } from "./client.js";
import { createToolDefinitions, type ToolDefinition } from "./tools.js";

const READ_NAMES = [
  "paperclipListAgents", "paperclipListIssues", "paperclipGetIssue", "paperclipListComments",
] as const;
const WRITE_NAMES = [
  "paperclipCreateIssue", "paperclipUpdateIssue", "paperclipAddComment", "paperclipDelegateChildIssue",
] as const;

export function createRunTaskTools(
  config: ConstructorParameters<typeof PaperclipApiClient>[0],
  allowWrites: boolean,
): ToolDefinition[] {
  const selected = new Set<string>(allowWrites ? [...READ_NAMES, ...WRITE_NAMES] : READ_NAMES);
  const tools = createToolDefinitions(new PaperclipApiClient(config, 60_000)).filter((tool) => selected.has(tool.name));
  if (tools.length !== selected.size) throw new Error("The run task tool catalogue is incomplete");
  return tools;
}
