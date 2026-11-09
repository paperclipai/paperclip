import { describe, expect, it } from "vitest";
import {
  BookOpen,
  Brain,
  ChevronsLeftRightEllipsis,
  CircleHelp,
  FilePenLine,
  MessageSquareReply,
  Network,
  Search,
  SearchCode,
  Terminal,
  Wrench,
} from "lucide-react";
import { McpIcon } from "./McpIcon";
import {
  humanizeToolName,
  isGenericToolName,
  mcpToolIdentity,
  mcpToolSegment,
  statusLabelIcon,
  toolActivityPresentation,
  toolTaxonomy,
} from "./tool-taxonomy";

describe("tool activity vocabulary", () => {
  it("maps Claude, Codex, and Pi built-ins to action-specific copy and icons", () => {
    expect(toolTaxonomy("Bash")).toEqual({ family: "terminal", icon: Terminal, verbLabel: "Running a command" });
    expect(toolTaxonomy("exec_command")).toEqual({ family: "terminal", icon: Terminal, verbLabel: "Running a command" });
    expect(toolTaxonomy("Grep")).toEqual({ family: "grep", icon: SearchCode, verbLabel: "Searching file contents" });
    expect(toolTaxonomy("Glob")).toEqual({ family: "search", icon: Search, verbLabel: "Searching files" });
    expect(toolTaxonomy("Read")).toEqual({ family: "read", icon: BookOpen, verbLabel: "Reading a file" });
    expect(toolTaxonomy("NotebookEdit")).toEqual({ family: "edit", icon: FilePenLine, verbLabel: "Editing a notebook" });
    expect(toolTaxonomy("WebFetch")).toEqual({ family: "web", icon: ChevronsLeftRightEllipsis, verbLabel: "Fetching a web page" });
    expect(toolTaxonomy("Agent")).toEqual({ family: "agent", icon: Network, verbLabel: "Starting a subagent" });
    expect(toolTaxonomy("AskUserQuestion")).toEqual({ family: "question", icon: CircleHelp, verbLabel: "Requesting input" });
  });

  it("normalizes camel, Pascal, snake, kebab, dotted, and both MCP formats", () => {
    for (const name of ["searchIssues", "SearchIssues", "search_issues", "search-issues", "search.issues"]) {
      expect(toolActivityPresentation({ name }).runningLabel).toBe("Searching issues");
    }
    expect(mcpToolIdentity("mcp__linear-server__search_issues")).toEqual({ namespace: "linear-server", name: "search_issues" });
    expect(mcpToolIdentity("mcp.linear-server.search_issues")).toEqual({ namespace: "linear-server", name: "search_issues" });
    expect(mcpToolSegment("mcp__linear-server__search_issues")).toBe("Search issues");
    expect(mcpToolSegment("mcp.linear-server.search_issues")).toBe("Search issues");
    const mcp = toolActivityPresentation({ name: "mcp.paperclip.search_tasks" });
    expect(mcp).toMatchObject({
      family: "mcp",
      icon: McpIcon,
      runningLabel: "Searching tasks",
      completedLabel: "Searched tasks",
      sourceLabel: "Paperclip",
      confidence: "exact",
    });
  });

  it("covers every ACP kind before falling back to a future extension name", () => {
    const expected: Record<string, string> = {
      read: "Reading data",
      edit: "Updating data",
      delete: "Deleting an item",
      move: "Moving an item",
      search: "Searching",
      execute: "Running a command",
      think: "Thinking",
      fetch: "Fetching data",
      switch_mode: "Switching mode",
      other: "Running Custom extension",
    };
    for (const [operation, runningLabel] of Object.entries(expected)) {
      expect(toolActivityPresentation({ name: "custom_extension", operation }).runningLabel).toBe(runningLabel);
    }
    expect(toolActivityPresentation({ name: "Read file '/tmp/private.json'", operation: "read" }).runningLabel).toBe("Reading data");
  });

  it("covers every normalized verb-prefix family", () => {
    const cases: Array<[string, string]> = [
      ["get_record", "Reading record"], ["list_records", "Listing records"],
      ["lookup_record", "Searching record"], ["fetch_record", "Fetching record"],
      ["open_record", "Opening record"], ["patch_record", "Updating record"],
      ["register_record", "Creating record"], ["remove_record", "Deleting record"],
      ["rename_record", "Moving record"], ["execute_record", "Running a command"],
      ["prompt_user", "Requesting user"], ["comment_record", "Posting record"],
      ["delegate_record", "Starting record"], ["interrupt_record", "Stopping record"],
      ["poll_record", "Waiting"], ["complete_record", "Reporting completion"],
      ["block_record", "Reporting a blocker"],
    ];
    for (const [name, runningLabel] of cases) {
      expect(toolActivityPresentation({ name }).runningLabel).toBe(runningLabel);
    }
  });

  it("gives anticipated provider tools and Paperclip operations purpose-specific labels", () => {
    const anticipated = [
      "ToolSearch", "NotebookRead", "NotebookEdit", "TaskOutput", "TaskStop", "SendMessage",
      "EnterPlanMode", "ExitPlanMode", "LSP", "TodoWrite", "ReportFindings", "Skill",
      "view_image", "Image generation", "Compact conversation", "Guardian Review",
      "apply_patch", "multi_tool_use.parallel", "wait_agent", "interrupt_agent",
    ];
    const paperclip = [
      "get_task_context", "get_task_history", "list_documents", "read_document", "list_document_revisions",
      "report_progress", "answer_status_question", "write_document", "request_human_input",
      "register_deliverable", "finish_task", "paperclip_finish", "block_task", "paperclip_block",
      "request_review", "list_agents", "get_agent", "search_tasks", "list_approvals", "get_approval",
      "get_approval_context", "get_workspace_runtime", "control_workspace_service", "set_dependencies",
      "create_task", "request_approval", "decide_approval", "comment_on_approval", "schedule_wake",
      "generic_api_request",
    ];
    for (const name of [...anticipated, ...paperclip]) {
      const presentation = toolActivityPresentation({ name, namespace: paperclip.includes(name) ? "paperclip" : undefined });
      expect(presentation.confidence, name).toBe("exact");
      expect(presentation.runningLabel, name).not.toMatch(/running a tool|tool call/i);
      expect(presentation.completedLabel, name).not.toMatch(/ran a tool|tool call/i);
    }
    expect(toolActivityPresentation({ name: "report_progress", namespace: "paperclip" }).runningLabel).toBe("Reporting progress");
    expect(toolActivityPresentation({ name: "paperclip_block", namespace: "paperclip" }).completedLabel).toBe("Reported a blocker");
    expect(toolActivityPresentation({ name: "schedule_wake", namespace: "paperclip" }).runningLabel).toBe("Scheduling a wake-up");
  });

  it("humanizes unknown named extensions and reserves the unnamed copy for missing identity", () => {
    expect(toolActivityPresentation({ name: "CustomExtension" })).toMatchObject({
      icon: Wrench,
      runningLabel: "Running Custom extension",
      completedLabel: "Ran Custom extension",
      displayName: "Custom extension",
      confidence: "fallback",
    });
    for (const name of ["", undefined, null, "tool call"]) {
      expect(toolActivityPresentation({ name })).toMatchObject({
        runningLabel: "Running an unnamed tool",
        completedLabel: "Ran an unnamed tool",
        confidence: "unnamed",
      });
    }
    expect(humanizeToolName("someFuture-extension.v2")).toBe("Some future extension v2");
  });
});

describe("status and placeholder helpers", () => {
  it("gives tool-free informative statuses their glyphs", () => {
    expect(statusLabelIcon("Thinking")).toBe(Brain);
    expect(statusLabelIcon("Responding")).toBe(MessageSquareReply);
    expect(statusLabelIcon("Responding (streaming)")).toBe(MessageSquareReply);
    expect(statusLabelIcon("Working")).toBeNull();
  });

  it("recognizes ACPX placeholders but keeps real names", () => {
    for (const name of ["tool call", "tool call (completed)", "Tool Call (failed)", "acp_tool", "tool", ""]) {
      expect(isGenericToolName(name)).toBe(true);
    }
    expect(isGenericToolName("Terminal")).toBe(false);
    expect(isGenericToolName("mcp__linear__search_issues")).toBe(false);
  });
});
