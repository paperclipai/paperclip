export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const PAPERCLIP_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "paperclip_get_identity",
      description: "Get the current agent's identity, role, and chain of command.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_inbox",
      description: "Get compact list of tasks assigned to this agent.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_checkout_issue",
      description: "Claim a task for this agent. Must be called before any work.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string", description: "The issue UUID" },
          expectedStatuses: {
            type: "array",
            items: { type: "string" },
            description: "Expected current statuses, e.g. ['todo', 'in_review']",
          },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_update_issue",
      description: "Update issue status, priority, or add a comment.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
          },
          comment: { type: "string", description: "Markdown comment" },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          title: { type: "string" },
          description: { type: "string" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_add_comment",
      description: "Add a markdown comment to an issue without changing its status.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
          body: { type: "string", description: "Markdown comment content" },
        },
        required: ["issueId", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_issue_context",
      description: "Get compact issue context with ancestors and goal info (no full comment thread).",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_get_comments",
      description: "Fetch the full comment thread of an issue.",
      parameters: {
        type: "object",
        properties: {
          issueId: { type: "string" },
        },
        required: ["issueId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "paperclip_create_subtask",
      description: "Create a new task (issue) under a parent issue.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          parentId: { type: "string", description: "Parent issue ID" },
          assigneeAgentId: { type: "string" },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
          },
          status: {
            type: "string",
            enum: ["backlog", "todo", "in_progress"],
          },
        },
        required: ["title", "parentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_read_file",
      description: "Read a file's content from the agent's working directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from cwd" },
          offset: { type: "number", description: "Start line (1-indexed)" },
          limit: { type: "number", description: "Max lines to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write_file",
      description: "Write content to a file (creates or overwrites).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path from cwd" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_list_directory",
      description: "List entries in a directory.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path (default: cwd)" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_glob",
      description: "Find files by glob pattern (e.g. '**/*.ts').",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Base directory (default: cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_grep",
      description: "Search for a regex pattern in files.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern" },
          path: { type: "string", description: "File or directory to search" },
          glob: { type: "string", description: "Filter files by glob (e.g. '*.ts')" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell_exec",
      description: "Execute a shell command in the agent's working directory.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout: { type: "number", description: "Timeout in ms (default 30000, max 120000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Show git working tree status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "Show git diff.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Optional ref/commit to diff against" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage files and create a commit.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Files to add (relative paths)",
          },
          message: { type: "string", description: "Commit message" },
        },
        required: ["files", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_log",
      description: "Show recent git commits.",
      parameters: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of commits (default 10)" },
        },
      },
    },
  },
];
