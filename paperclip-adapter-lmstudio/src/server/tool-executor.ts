import { executePaperclipTool, PaperclipContext, ToolResult } from "./paperclip-tools.js";
import { executeFsTool } from "./fs-tools.js";
import { executeShellTool } from "./shell-tools.js";

export interface DispatchParams {
  name: string;
  args: Record<string, unknown>;
  cwd: string;
  paperclipCtx: PaperclipContext;
}

export async function dispatchTool(params: DispatchParams): Promise<ToolResult> {
  const { name, args, cwd, paperclipCtx } = params;

  if (name.startsWith("paperclip_")) {
    return executePaperclipTool(name, args, paperclipCtx);
  }
  if (name.startsWith("fs_")) {
    return executeFsTool(name, args, cwd);
  }
  if (name.startsWith("shell_") || name.startsWith("git_")) {
    return executeShellTool(name, args, cwd);
  }
  return { content: `Unknown tool: ${name}`, isError: true };
}
