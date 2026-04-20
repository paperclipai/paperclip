import type { Goal, Issue } from "@paperclipai/shared";

/**
 * Represents a single Obsidian note to be written to the vault.
 */
export interface ObsidianNote {
  /** Relative path within the vault (e.g. "Projects/Website/Issues/PAP-42.md") */
  relativePath: string;
  /** YAML frontmatter fields */
  frontmatter: Record<string, unknown>;
  /** Markdown body content */
  body: string;
}

export interface MapperContext {
  /** Map of project IDs to project names */
  projectNames: Map<string, string>;
  /** Map of agent IDs to agent names */
  agentNames: Map<string, string>;
  /** Map of goal IDs to goal titles */
  goalTitles: Map<string, string>;
  /** Comments keyed by issue ID */
  commentsByIssue: Map<string, Array<{ body: string; createdAt: string; authorName: string }>>;
  /** Folder structure preference */
  folderStructure: "by-project" | "flat";
  /** Whether to include comments */
  includeComments: boolean;
  /** Max comments per issue */
  maxCommentsPerIssue: number;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
}

function issueFolder(issue: Issue, ctx: MapperContext): string {
  if (ctx.folderStructure === "flat") return "Issues";
  const projectName = issue.projectId ? (ctx.projectNames.get(issue.projectId) ?? "Uncategorized") : "Uncategorized";
  return `Projects/${sanitizeFilename(projectName)}/Issues`;
}

function goalFolder(goal: Goal, ctx: MapperContext): string {
  if (ctx.folderStructure === "flat") return "Goals";
  return "Goals";
}

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toISOString().split("T")[0];
}

function buildWikilinks(text: string): string {
  // Convert PAP-123 style references to [[PAP-123]] wikilinks
  return text.replace(/\b([A-Z]+-\d+)\b/g, "[[$1]]");
}

export function mapIssueToNote(issue: Issue, ctx: MapperContext): ObsidianNote {
  const identifier = issue.identifier ?? `issue-${issue.id.slice(0, 8)}`;
  const filename = sanitizeFilename(identifier);
  const folder = issueFolder(issue, ctx);
  const relativePath = `${folder}/${filename}.md`;

  const assignee = issue.assigneeAgentId ? (ctx.agentNames.get(issue.assigneeAgentId) ?? null) : null;
  const project = issue.projectId ? (ctx.projectNames.get(issue.projectId) ?? null) : null;
  const goalTitle = issue.goalId ? (ctx.goalTitles.get(issue.goalId) ?? null) : null;

  const frontmatter: Record<string, unknown> = {
    paperclip_id: issue.id,
    identifier,
    status: issue.status,
    priority: issue.priority,
    assignee,
    project,
    goal: goalTitle,
    parent: issue.parentId ?? null,
    created: formatDate(issue.createdAt),
    updated: formatDate(issue.updatedAt),
    tags: ["paperclip", "issue"],
  };

  let body = `# ${issue.title}\n\n`;

  if (issue.description) {
    body += buildWikilinks(issue.description) + "\n\n";
  }

  if (ctx.includeComments) {
    const comments = ctx.commentsByIssue.get(issue.id) ?? [];
    const recent = comments.slice(-ctx.maxCommentsPerIssue);
    if (recent.length > 0) {
      body += "## Comments\n\n";
      for (const c of recent) {
        const date = formatDate(c.createdAt);
        const author = c.authorName || "Unknown";
        body += `### ${author} — ${date}\n\n`;
        body += buildWikilinks(c.body) + "\n\n";
      }
    }
  }

  // Add related issue wikilinks
  if (issue.parentId) {
    const parentIdentifier = issue.parentId; // Will be resolved to identifier if available
    body += `---\nParent: [[${parentIdentifier}]]\n`;
  }

  return { relativePath, frontmatter, body };
}

export function mapGoalToNote(goal: Goal, ctx: MapperContext): ObsidianNote {
  const filename = sanitizeFilename(goal.title || `goal-${goal.id.slice(0, 8)}`);
  const folder = goalFolder(goal, ctx);
  const relativePath = `${folder}/${filename}.md`;

  const owner = goal.ownerAgentId ? (ctx.agentNames.get(goal.ownerAgentId) ?? null) : null;

  const frontmatter: Record<string, unknown> = {
    paperclip_id: goal.id,
    level: goal.level,
    status: goal.status,
    owner,
    parent_goal: goal.parentId ?? null,
    created: formatDate(goal.createdAt),
    updated: formatDate(goal.updatedAt),
    tags: ["paperclip", "goal"],
  };

  let body = `# ${goal.title}\n\n`;

  if (goal.description) {
    body += buildWikilinks(goal.description) + "\n\n";
  }

  return { relativePath, frontmatter, body };
}
