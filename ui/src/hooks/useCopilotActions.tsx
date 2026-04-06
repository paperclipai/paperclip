import { useFrontendTool, useAgentContext, useConfigureSuggestions, useHumanInTheLoop, ToolCallStatus } from "@copilotkit/react-core/v2";
import { z } from "zod";
import { useNavigate, useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { goalsApi } from "../api/goals";
import { agentsApi } from "../api/agents";
import { companiesApi } from "../api/companies";
import { approvalsApi } from "../api/approvals";
import { costsApi } from "../api/costs";
import { dashboardApi } from "../api/dashboard";
import { activityApi } from "../api/activity";
import { heartbeatsApi } from "../api/heartbeats";
import { secretsApi } from "../api/secrets";
import {
  ChatLoadingSkeleton,
  ChatDashboardCard,
  ChatAgentStatusGrid,
  ChatIssueList,
  ChatCostBreakdown,
  ChatApprovalCard,
  ChatOrgChart,
  ChatGoalList,
} from "../components/chat";
import { useCallback, useMemo, useRef } from "react";

export function useCopilotActions() {
  const navigate = useNavigate();
  const location = useLocation();
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewIssue, openNewProject, openNewGoal, openNewAgent } = useDialog();
  const queryClient = useQueryClient();

  const lastGoalsRef = useRef<unknown[]>([]);

  const companyNav = useCallback(
    (subpath: string) => {
      if (selectedCompany) navigate(`/${selectedCompany.issuePrefix}/${subpath}`);
    },
    [selectedCompany, navigate],
  );

  // ── Readable context ──────────────────────────────────────────────

  useAgentContext({
    description: "System context — you are the Paperclip AI assistant embedded in the Paperclip control-plane dashboard. Paperclip orchestrates AI agent companies with issues, projects, goals, agents, approvals, and budgets. Be concise and action-oriented. Prefer executing actions over lengthy explanations. When referring to entities include their identifier (e.g. ACME-42) when available.",
    value: "Paperclip AI assistant active",
  });

  useAgentContext({
    description: "Current page URL path",
    value: location.pathname,
  });

  useAgentContext({
    description: "Currently selected company (the org/workspace the user is viewing)",
    value: selectedCompany
      ? {
          id: selectedCompany.id,
          name: selectedCompany.name,
          description: selectedCompany.description,
          issuePrefix: selectedCompany.issuePrefix,
          status: selectedCompany.status,
          budgetMonthlyCents: selectedCompany.budgetMonthlyCents,
          spentMonthlyCents: selectedCompany.spentMonthlyCents,
        }
      : null,
  });

  useAgentContext({
    description: "All companies available to the user",
    value: companies.map((c) => ({ id: c.id, name: c.name, issuePrefix: c.issuePrefix, status: c.status })),
  });

  // ── Chat suggestions ──────────────────────────────────────────────

  const staticSuggestions = useMemo(() => {
    const path = location.pathname.toLowerCase();

    // Page-specific suggestions
    if (path.includes("/dashboard")) {
      return [
        { title: "Dashboard summary", message: "How's the company doing?" },
        { title: "Check agent status", message: "Show me the agents" },
        { title: "View spend", message: "What's our spend this month?" },
      ];
    }
    if (path.includes("/issues")) {
      return [
        { title: "Open issues", message: "Show me open issues" },
        { title: "Urgent issues", message: "Any urgent issues?" },
        { title: "Create issue", message: "Create a new issue" },
      ];
    }
    if (path.includes("/agents")) {
      return [
        { title: "Agent status", message: "Show me all agents" },
        { title: "Org chart", message: "Show me the org chart" },
        { title: "Agent costs", message: "Which agent is spending the most?" },
      ];
    }
    if (path.includes("/costs")) {
      return [
        { title: "Cost summary", message: "What's our spend this month?" },
        { title: "Top spenders", message: "Which agents cost the most?" },
        { title: "Budget status", message: "How much budget is left?" },
      ];
    }
    if (path.includes("/approvals")) {
      return [
        { title: "Pending approvals", message: "Any pending approvals?" },
        { title: "Review approvals", message: "Show me all pending approvals so I can review them" },
        { title: "Dashboard", message: "How's the company doing?" },
      ];
    }
    if (path.includes("/projects")) {
      return [
        { title: "List projects", message: "Show me all projects" },
        { title: "Project issues", message: "What issues are in this project?" },
        { title: "Create project", message: "Create a new project" },
      ];
    }
    if (path.includes("/goals")) {
      return [
        { title: "List goals", message: "Show me all goals" },
        { title: "Create goal", message: "Create a new goal" },
        { title: "Dashboard", message: "How's the company doing?" },
      ];
    }

    // Default suggestions
    return [
      { title: "Dashboard overview", message: "How's the company doing?" },
      { title: "Show agents", message: "Show me the agents" },
      { title: "Open issues", message: "What issues are open?" },
    ];
  }, [location.pathname]);

  // Static chips — instant, no LLM round-trip
  useConfigureSuggestions({
    suggestions: staticSuggestions,
    available: "always",
  }, [staticSuggestions]);

  // ── Navigation ────────────────────────────────────────────────────

  useFrontendTool({
    name: "navigate",
    description: "Navigate to a page in the app. Use issue prefix for company routes (e.g. /ACME/issues, /ACME/agents, /ACME/projects, /ACME/goals, /ACME/approvals, /ACME/costs, /ACME/dashboard, /instance/settings/heartbeats).",
    parameters: z.object({
      path: z.string().describe("The URL path to navigate to"),
    }),
    handler: async ({ path }) => {
      navigate(path);
      return `Navigated to ${path}`;
    },
  });

  useFrontendTool({
    name: "switchCompany",
    description: "Switch to a different company/workspace",
    parameters: z.object({
      companyId: z.string().describe("The company ID to switch to"),
    }),
    handler: async ({ companyId }) => {
      setSelectedCompanyId(companyId, { source: "manual" });
      const company = companies.find((c) => c.id === companyId);
      if (company) navigate(`/${company.issuePrefix}/issues`);
      return `Switched to company ${company?.name ?? companyId}`;
    },
  });

  // ── Companies ─────────────────────────────────────────────────────

  useFrontendTool({
    name: "listCompanies",
    description: "List all companies/workspaces",
    parameters: z.object({}),
    handler: async () => {
      const result = await companiesApi.list();
      return JSON.stringify(result.map((c) => ({ id: c.id, name: c.name, issuePrefix: c.issuePrefix, status: c.status, description: c.description })));
    },
  });

  useFrontendTool({
    name: "createCompany",
    description: "Create a new company/workspace",
    parameters: z.object({
      name: z.string().describe("Company name"),
      description: z.string().optional().describe("Company description"),
      budgetMonthlyCents: z.number().optional().describe("Monthly budget in cents"),
    }),
    handler: async ({ name, description, budgetMonthlyCents }) => {
      const result = await companiesApi.create({ name, description, budgetMonthlyCents });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      return JSON.stringify({ id: result.id, name: result.name, issuePrefix: result.issuePrefix });
    },
  });

  useFrontendTool({
    name: "updateCompany",
    description: "Update a company's settings",
    parameters: z.object({
      companyId: z.string().describe("Company ID"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      budgetMonthlyCents: z.number().optional().describe("New monthly budget in cents"),
      status: z.string().optional().describe("New status"),
    }),
    handler: async ({ companyId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await companiesApi.update(companyId, data);
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      return JSON.stringify({ id: result.id, name: result.name });
    },
  });

  // ── Issues ────────────────────────────────────────────────────────

  useFrontendTool({
    name: "listIssues",
    description: "List issues for the current company. Can filter by status, project, assignee, or search query.",
    parameters: z.object({
      status: z.string().optional().describe("Filter by status (backlog, todo, in_progress, in_review, done, cancelled)"),
      projectId: z.string().optional().describe("Filter by project ID"),
      assigneeAgentId: z.string().optional().describe("Filter by assigned agent ID"),
      q: z.string().optional().describe("Search query"),
    }),
    handler: async ({ status, projectId, assigneeAgentId, q }) => {
      if (!selectedCompanyId) return "No company selected";
      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (projectId) filters.projectId = projectId;
      if (assigneeAgentId) filters.assigneeAgentId = assigneeAgentId;
      if (q) filters.q = q;
      const result = await issuesApi.list(selectedCompanyId, filters);
      return JSON.stringify(result.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        status: i.status,
        priority: i.priority,
        assigneeAgentId: i.assigneeAgentId,
        projectId: i.projectId,
      })));
    },
    render: ({ status, result }) => {
      if (status === ToolCallStatus.Complete && result) {
        try {
          const issues = JSON.parse(result as string);
          return <ChatIssueList issues={issues} onNavigate={companyNav} />;
        } catch { /* fallback to text */ }
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useFrontendTool({
    name: "getIssue",
    description: "Get full details of a specific issue",
    parameters: z.object({
      issueId: z.string().describe("The issue ID"),
    }),
    handler: async ({ issueId }) => {
      return JSON.stringify(await issuesApi.get(issueId));
    },
  });

  useHumanInTheLoop({
    name: "createIssue",
    description: "Create a new issue/task (requires user confirmation)",
    parameters: z.object({
      title: z.string().describe("Issue title"),
      description: z.string().optional().describe("Issue description (markdown)"),
      status: z.string().optional().describe("Status: backlog, todo, in_progress, in_review, done, cancelled"),
      priority: z.string().optional().describe("Priority: none, low, medium, high, urgent"),
      projectId: z.string().optional().describe("Project ID to assign to"),
      assigneeAgentId: z.string().optional().describe("Agent ID to assign"),
      assigneeUserId: z.string().optional().describe("User ID to assign (for human assignees like the CEO)"),
      goalId: z.string().optional().describe("Goal ID to link to"),
    }),
    render: ({ args, respond, status }) => {
      if (status === ToolCallStatus.Complete) {
        return <p className="text-sm text-muted-foreground">Issue created.</p>;
      }
      if (status === ToolCallStatus.Executing && respond) {
        const priorityColors: Record<string, string> = {
          urgent: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
          high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
          medium: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
          low: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
        };
        const statusColors: Record<string, string> = {
          backlog: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
          todo: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
          in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
          in_review: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
          done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
          cancelled: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
        };
        return (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Create Issue
            </p>
            <p className="text-xs font-medium">{args.title}</p>
            {args.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">{args.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {args.status && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusColors[args.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                  {args.status.replace(/_/g, " ")}
                </span>
              )}
              {args.priority && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${priorityColors[args.priority] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                  {args.priority}
                </span>
              )}
              {args.assigneeAgentId && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                  Agent: {args.assigneeAgentId.slice(0, 8)}
                </span>
              )}
              {args.assigneeUserId && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                  User: {args.assigneeUserId.slice(0, 8)}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                onClick={async () => {
                  if (!selectedCompanyId) {
                    respond("No company selected");
                    return;
                  }
                  try {
                    const data: Record<string, unknown> = { title: args.title };
                    if (args.description) data.description = args.description;
                    if (args.status) data.status = args.status;
                    if (args.priority) data.priority = args.priority;
                    if (args.projectId) data.projectId = args.projectId;
                    if (args.assigneeAgentId) data.assigneeAgentId = args.assigneeAgentId;
                    if (args.assigneeUserId) data.assigneeUserId = args.assigneeUserId;
                    if (args.goalId) data.goalId = args.goalId;
                    const result = await issuesApi.create(selectedCompanyId, data);
                    queryClient.invalidateQueries({ queryKey: ["issues"] });
                    respond(`Created issue ${result.identifier ?? result.id} — "${result.title}"`);
                  } catch (err) {
                    respond(`Failed to create issue: ${err instanceof Error ? err.message : "Unknown error"}`);
                  }
                }}
              >
                Create
              </button>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                onClick={() => respond("Cancelled by user")}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      }
      return null;
    },
  });

  useFrontendTool({
    name: "updateIssue",
    description: "Update an existing issue",
    parameters: z.object({
      issueId: z.string().describe("Issue ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      status: z.string().optional().describe("New status"),
      priority: z.string().optional().describe("New priority"),
      projectId: z.string().optional().describe("New project ID"),
      assigneeAgentId: z.string().optional().describe("New assignee agent ID"),
      assigneeUserId: z.string().optional().describe("New assignee user ID (for human assignees)"),
      goalId: z.string().optional().describe("New goal ID"),
    }),
    handler: async ({ issueId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await issuesApi.update(issueId, data);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      return JSON.stringify({ id: result.id, identifier: result.identifier, title: result.title, status: result.status });
    },
  });

  useFrontendTool({
    name: "addIssueComment",
    description: "Add a comment to an issue",
    parameters: z.object({
      issueId: z.string().describe("Issue ID"),
      body: z.string().describe("Comment body (markdown)"),
      reopen: z.boolean().optional().describe("Whether to reopen the issue if closed"),
    }),
    handler: async ({ issueId, body, reopen }) => {
      const result = await issuesApi.addComment(issueId, body, reopen);
      queryClient.invalidateQueries({ queryKey: ["issues", issueId] });
      return JSON.stringify({ id: result.id, body: result.body });
    },
  });

  useFrontendTool({
    name: "listIssueComments",
    description: "List all comments on an issue",
    parameters: z.object({
      issueId: z.string().describe("Issue ID"),
    }),
    handler: async ({ issueId }) => {
      return JSON.stringify(await issuesApi.listComments(issueId));
    },
  });

  // ── Delete Issue (Human-in-the-loop) ─────────────────────────────

  useHumanInTheLoop({
    name: "deleteIssue",
    description: "Delete an issue (requires user confirmation)",
    parameters: z.object({
      issueId: z.string().describe("Issue ID"),
    }),
    render: ({ args, respond, status }) => {
      if (status === ToolCallStatus.Complete) {
        return <p className="text-sm text-muted-foreground">Issue deleted.</p>;
      }
      if (status === ToolCallStatus.Executing && respond) {
        // Try to resolve a human-readable identifier from the query cache
        const cached = queryClient.getQueriesData<Array<{ id: string; identifier?: string; title?: string }>>({ queryKey: ["issues"] });
        let displayName = args.issueId.slice(0, 8);
        let issueTitle: string | undefined;
        for (const [, data] of cached) {
          const match = Array.isArray(data) ? data.find((i) => i.id === args.issueId) : undefined;
          if (match) {
            if (match.identifier) displayName = match.identifier;
            issueTitle = match.title;
            break;
          }
        }
        return (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
            <p>Delete issue <strong>{displayName}</strong>{issueTitle ? ` (${issueTitle})` : ""}? This cannot be undone.</p>
            <div className="flex gap-2">
              <button
                className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:bg-destructive/90"
                onClick={async () => {
                  try {
                    await issuesApi.remove(args.issueId);
                    queryClient.invalidateQueries({ queryKey: ["issues"] });
                    respond("Issue deleted");
                  } catch (err) {
                    respond(`Failed to delete issue: ${err instanceof Error ? err.message : "Unknown error"}`);
                  }
                }}
              >
                Delete
              </button>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                onClick={() => respond("Cancelled by user")}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      }
      return null;
    },
  });

  // ── Issue Labels ──────────────────────────────────────────────────

  useFrontendTool({
    name: "listLabels",
    description: "List all issue labels for the current company",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await issuesApi.listLabels(selectedCompanyId));
    },
  });

  useFrontendTool({
    name: "createLabel",
    description: "Create a new issue label",
    parameters: z.object({
      name: z.string().describe("Label name"),
      color: z.string().describe("Label color (hex)"),
    }),
    handler: async ({ name, color }) => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await issuesApi.createLabel(selectedCompanyId, { name, color }));
    },
  });

  // ── Projects ──────────────────────────────────────────────────────

  useFrontendTool({
    name: "listProjects",
    description: "List all projects for the current company",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await projectsApi.list(selectedCompanyId);
      return JSON.stringify(result.map((p) => ({
        id: p.id,
        name: p.name,
        urlKey: p.urlKey,
        status: p.status,
        description: p.description,
        leadAgentId: p.leadAgentId,
        targetDate: p.targetDate,
      })));
    },
  });

  useFrontendTool({
    name: "getProject",
    description: "Get full details of a project",
    parameters: z.object({
      projectId: z.string().describe("Project ID"),
    }),
    handler: async ({ projectId }) => {
      return JSON.stringify(await projectsApi.get(projectId));
    },
  });

  useFrontendTool({
    name: "createProject",
    description: "Create a new project",
    parameters: z.object({
      name: z.string().describe("Project name"),
      description: z.string().optional().describe("Project description"),
      leadAgentId: z.string().optional().describe("Lead agent ID"),
      targetDate: z.string().optional().describe("Target date (YYYY-MM-DD)"),
    }),
    handler: async ({ name, description, leadAgentId, targetDate }) => {
      if (!selectedCompanyId) return "No company selected";
      const data: Record<string, unknown> = { name };
      if (description) data.description = description;
      if (leadAgentId) data.leadAgentId = leadAgentId;
      if (targetDate) data.targetDate = targetDate;
      const result = await projectsApi.create(selectedCompanyId, data);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      return JSON.stringify({ id: result.id, name: result.name, urlKey: result.urlKey });
    },
  });

  useFrontendTool({
    name: "updateProject",
    description: "Update a project",
    parameters: z.object({
      projectId: z.string().describe("Project ID"),
      name: z.string().optional().describe("New name"),
      description: z.string().optional().describe("New description"),
      status: z.string().optional().describe("New status (planned, active, paused, completed, cancelled)"),
      leadAgentId: z.string().optional().describe("New lead agent ID"),
      targetDate: z.string().optional().describe("New target date"),
    }),
    handler: async ({ projectId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await projectsApi.update(projectId, data);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      return JSON.stringify({ id: result.id, name: result.name, status: result.status });
    },
  });

  // ── Delete Project (Human-in-the-loop) ────────────────────────────

  useHumanInTheLoop({
    name: "deleteProject",
    description: "Delete a project (requires user confirmation)",
    parameters: z.object({
      projectId: z.string().describe("Project ID"),
    }),
    render: ({ args, respond, status }) => {
      if (status === ToolCallStatus.Complete) {
        return <p className="text-sm text-muted-foreground">Project deleted.</p>;
      }
      if (status === ToolCallStatus.Executing && respond) {
        return (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
            <p>Delete project <strong>{args.projectId}</strong>? This cannot be undone.</p>
            <div className="flex gap-2">
              <button
                className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:bg-destructive/90"
                onClick={async () => {
                  try {
                    await projectsApi.remove(args.projectId);
                    queryClient.invalidateQueries({ queryKey: ["projects"] });
                    respond("Project deleted");
                  } catch (err) {
                    respond(`Failed to delete project: ${err instanceof Error ? err.message : "Unknown error"}`);
                  }
                }}
              >
                Delete
              </button>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                onClick={() => respond("Cancelled by user")}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      }
      return null;
    },
  });

  // ── Goals ─────────────────────────────────────────────────────────

  useFrontendTool({
    name: "listGoals",
    description: "List all goals for the current company",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await goalsApi.list(selectedCompanyId);
      const goals = result.map((g) => ({
        id: g.id,
        title: g.title,
        status: g.status,
        level: g.level,
        description: g.description,
        parentId: g.parentId,
        ownerAgentId: g.ownerAgentId,
      }));
      lastGoalsRef.current = goals;
      const summary = goals.map((g) => `• ${g.title} — ${g.status} (${g.level})`).join("\n");
      return `${goals.length} goal(s):\n${summary}`;
    },
    render: ({ status }) => {
      if (status === ToolCallStatus.Complete && lastGoalsRef.current.length > 0) {
        return <ChatGoalList goals={lastGoalsRef.current as never[]} onNavigate={companyNav} />;
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useHumanInTheLoop({
    name: "createGoal",
    description: "Create a new goal (requires user confirmation)",
    parameters: z.object({
      title: z.string().describe("Goal title"),
      description: z.string().optional().describe("Goal description"),
      level: z.string().optional().describe("Goal level (company, team, individual)"),
      parentId: z.string().optional().describe("Parent goal ID for sub-goals"),
      ownerAgentId: z.string().optional().describe("Owner agent ID"),
    }),
    render: ({ args, respond, status }) => {
      if (status === ToolCallStatus.Complete) {
        return <p className="text-sm text-muted-foreground">Goal created.</p>;
      }
      if (status === ToolCallStatus.Executing && respond) {
        const levelColors: Record<string, string> = {
          company: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
          team: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
          individual: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
        };
        return (
          <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Create Goal
            </p>
            <p className="text-xs font-medium">{args.title}</p>
            {args.description && (
              <p className="text-xs text-muted-foreground">{args.description}</p>
            )}
            <div className="flex items-center gap-2">
              {args.level && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${levelColors[args.level] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                  {args.level}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <button
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
                onClick={async () => {
                  if (!selectedCompanyId) {
                    respond("No company selected");
                    return;
                  }
                  const data: Record<string, unknown> = { title: args.title };
                  if (args.description) data.description = args.description;
                  if (args.level) data.level = args.level;
                  if (args.parentId) data.parentId = args.parentId;
                  if (args.ownerAgentId) data.ownerAgentId = args.ownerAgentId;
                  const result = await goalsApi.create(selectedCompanyId, data);
                  queryClient.invalidateQueries({ queryKey: ["goals"] });
                  respond(`Created goal "${result.title}" (status: ${result.status})`);
                }}
              >
                Create
              </button>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                onClick={() => respond("Cancelled by user")}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      }
      return null;
    },
  });

  useFrontendTool({
    name: "updateGoal",
    description: "Update a goal",
    parameters: z.object({
      goalId: z.string().describe("Goal ID"),
      title: z.string().optional().describe("New title"),
      description: z.string().optional().describe("New description"),
      status: z.string().optional().describe("New status (active, completed, cancelled)"),
      ownerAgentId: z.string().optional().describe("New owner agent ID"),
    }),
    handler: async ({ goalId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await goalsApi.update(goalId, data);
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      return JSON.stringify({ id: result.id, title: result.title, status: result.status });
    },
  });

  // ── Agents ────────────────────────────────────────────────────────

  useFrontendTool({
    name: "listAgents",
    description: "List all agents for the current company",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await agentsApi.list(selectedCompanyId);
      return JSON.stringify(result.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        title: a.title,
        status: a.status,
        adapterType: a.adapterType,
        reportsTo: a.reportsTo,
      })));
    },
    render: ({ status, result }) => {
      if (status === ToolCallStatus.Complete && result) {
        try {
          const agents = JSON.parse(result as string);
          return <ChatAgentStatusGrid agents={agents} onNavigate={companyNav} />;
        } catch { /* fallback to text */ }
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useFrontendTool({
    name: "getAgent",
    description: "Get full details of an agent",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
    }),
    handler: async ({ agentId }) => {
      return JSON.stringify(await agentsApi.get(agentId));
    },
  });

  useFrontendTool({
    name: "getAgentOrgChart",
    description: "Get the org chart (reporting hierarchy) for the current company",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await agentsApi.org(selectedCompanyId));
    },
    render: ({ status, result }) => {
      if (status === ToolCallStatus.Complete && result) {
        try {
          const tree = JSON.parse(result as string);
          return <ChatOrgChart tree={tree} onNavigate={companyNav} />;
        } catch { /* fallback to text */ }
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useFrontendTool({
    name: "pauseAgent",
    description: "Pause an agent so it stops processing tasks",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
    }),
    handler: async ({ agentId }) => {
      const result = await agentsApi.pause(agentId);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      return JSON.stringify({ id: result.id, name: result.name, status: result.status });
    },
  });

  useFrontendTool({
    name: "resumeAgent",
    description: "Resume a paused agent",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
    }),
    handler: async ({ agentId }) => {
      const result = await agentsApi.resume(agentId);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      return JSON.stringify({ id: result.id, name: result.name, status: result.status });
    },
  });

  // ── Terminate Agent (Human-in-the-loop) ───────────────────────────

  useHumanInTheLoop({
    name: "terminateAgent",
    description: "Terminate an agent permanently (requires user confirmation)",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
    }),
    render: ({ args, respond, status }) => {
      if (status === ToolCallStatus.Complete) {
        return <p className="text-sm text-muted-foreground">Agent terminated.</p>;
      }
      if (status === ToolCallStatus.Executing && respond) {
        return (
          <div className="flex flex-col gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm">
            <p>Terminate agent <strong>{args.agentId}</strong>? This is permanent and cannot be undone.</p>
            <div className="flex gap-2">
              <button
                className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:bg-destructive/90"
                onClick={async () => {
                  try {
                    const result = await agentsApi.terminate(args.agentId);
                    queryClient.invalidateQueries({ queryKey: ["agents"] });
                    respond(`Agent ${result.name} terminated`);
                  } catch (err) {
                    respond(`Failed to terminate agent: ${err instanceof Error ? err.message : "Unknown error"}`);
                  }
                }}
              >
                Terminate
              </button>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
                onClick={() => respond("Cancelled by user")}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      }
      return null;
    },
  });

  useFrontendTool({
    name: "invokeAgent",
    description: "Trigger an agent heartbeat/run manually",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
    }),
    handler: async ({ agentId }) => {
      const result = await agentsApi.invoke(agentId);
      queryClient.invalidateQueries({ queryKey: ["heartbeat-runs"] });
      return JSON.stringify({ runId: result.id, status: result.status });
    },
  });

  useFrontendTool({
    name: "wakeupAgent",
    description: "Wake up an agent with a specific trigger",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
      reason: z.string().optional().describe("Reason for waking up the agent"),
    }),
    handler: async ({ agentId, reason }) => {
      const result = await agentsApi.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason });
      return JSON.stringify(result);
    },
  });

  useFrontendTool({
    name: "getAgentRuntimeState",
    description: "Get the runtime state of an agent (session info, task sessions)",
    parameters: z.object({
      agentId: z.string().describe("Agent ID"),
    }),
    handler: async ({ agentId }) => {
      return JSON.stringify(await agentsApi.runtimeState(agentId));
    },
  });

  // ── Approvals ─────────────────────────────────────────────────────

  useFrontendTool({
    name: "listApprovals",
    description: "List approvals for the current company",
    parameters: z.object({
      status: z.string().optional().describe("Filter by status (pending, approved, rejected, revision_requested)"),
    }),
    handler: async ({ status }) => {
      if (!selectedCompanyId) return "No company selected";
      const result = await approvalsApi.list(selectedCompanyId, status);
      return JSON.stringify(result.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        requestedByAgentId: a.requestedByAgentId,
        decisionNote: a.decisionNote,
        createdAt: a.createdAt,
      })));
    },
    render: ({ status, result }) => {
      if (status === ToolCallStatus.Complete && result) {
        try {
          const approvals = JSON.parse(result as string);
          return (
            <ChatApprovalCard
              approvals={approvals}
              onApprove={async (id) => {
                await approvalsApi.approve(id);
                queryClient.invalidateQueries({ queryKey: ["approvals"] });
              }}
              onReject={async (id) => {
                await approvalsApi.reject(id);
                queryClient.invalidateQueries({ queryKey: ["approvals"] });
              }}
              onRequestRevision={async (id) => {
                await approvalsApi.requestRevision(id);
                queryClient.invalidateQueries({ queryKey: ["approvals"] });
              }}
              onNavigate={companyNav}
            />
          );
        } catch { /* fallback to text */ }
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useFrontendTool({
    name: "getApproval",
    description: "Get full details of an approval request",
    parameters: z.object({
      approvalId: z.string().describe("Approval ID"),
    }),
    handler: async ({ approvalId }) => {
      return JSON.stringify(await approvalsApi.get(approvalId));
    },
  });

  useFrontendTool({
    name: "approveApproval",
    description: "Approve an approval request",
    parameters: z.object({
      approvalId: z.string().describe("Approval ID"),
      decisionNote: z.string().optional().describe("Note explaining the decision"),
    }),
    handler: async ({ approvalId, decisionNote }) => {
      const result = await approvalsApi.approve(approvalId, decisionNote);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return JSON.stringify({ id: result.id, status: result.status });
    },
  });

  useFrontendTool({
    name: "rejectApproval",
    description: "Reject an approval request",
    parameters: z.object({
      approvalId: z.string().describe("Approval ID"),
      decisionNote: z.string().optional().describe("Note explaining the rejection"),
    }),
    handler: async ({ approvalId, decisionNote }) => {
      const result = await approvalsApi.reject(approvalId, decisionNote);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return JSON.stringify({ id: result.id, status: result.status });
    },
  });

  useFrontendTool({
    name: "requestApprovalRevision",
    description: "Request revision on an approval",
    parameters: z.object({
      approvalId: z.string().describe("Approval ID"),
      decisionNote: z.string().optional().describe("Note explaining what needs revision"),
    }),
    handler: async ({ approvalId, decisionNote }) => {
      const result = await approvalsApi.requestRevision(approvalId, decisionNote);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return JSON.stringify({ id: result.id, status: result.status });
    },
  });

  // ── Dashboard & Costs ─────────────────────────────────────────────

  useFrontendTool({
    name: "getDashboard",
    description: "Get the dashboard summary for the current company (issue counts, agent activity, etc.)",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await dashboardApi.summary(selectedCompanyId));
    },
    render: ({ status, result }) => {
      if (status === ToolCallStatus.Complete && result) {
        try {
          const data = JSON.parse(result as string);
          return <ChatDashboardCard data={data} companyName={selectedCompany?.name} onNavigate={companyNav} />;
        } catch { /* fallback to text */ }
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useFrontendTool({
    name: "getCostSummary",
    description: "Get cost summary for the current company",
    parameters: z.object({
      from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
    handler: async ({ from, to }) => {
      if (!selectedCompanyId) return "No company selected";
      const [summary, agentCosts] = await Promise.all([
        costsApi.summary(selectedCompanyId, from, to),
        costsApi.byAgent(selectedCompanyId, from, to),
      ]);
      return JSON.stringify({ summary, agentCosts });
    },
    render: ({ status, result }) => {
      if (status === ToolCallStatus.Complete && result) {
        try {
          const { summary, agentCosts } = JSON.parse(result as string);
          return <ChatCostBreakdown summary={summary} agentCosts={agentCosts} onNavigate={companyNav} />;
        } catch { /* fallback to text */ }
      }
      return <ChatLoadingSkeleton />;
    },
  });

  useFrontendTool({
    name: "getCostsByAgent",
    description: "Get cost breakdown by agent for the current company",
    parameters: z.object({
      from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
    handler: async ({ from, to }) => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await costsApi.byAgent(selectedCompanyId, from, to));
    },
  });

  useFrontendTool({
    name: "getCostsByProject",
    description: "Get cost breakdown by project for the current company",
    parameters: z.object({
      from: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      to: z.string().optional().describe("End date (YYYY-MM-DD)"),
    }),
    handler: async ({ from, to }) => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await costsApi.byProject(selectedCompanyId, from, to));
    },
  });

  // ── Activity ──────────────────────────────────────────────────────

  useFrontendTool({
    name: "listActivity",
    description: "List recent activity events for the current company",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return JSON.stringify(await activityApi.list(selectedCompanyId));
    },
  });

  useFrontendTool({
    name: "getIssueActivity",
    description: "Get activity history for a specific issue",
    parameters: z.object({
      issueId: z.string().describe("Issue ID"),
    }),
    handler: async ({ issueId }) => {
      return JSON.stringify(await activityApi.forIssue(issueId));
    },
  });

  // ── Heartbeat Runs ────────────────────────────────────────────────

  useFrontendTool({
    name: "listHeartbeatRuns",
    description: "List agent heartbeat runs (execution history) for the current company",
    parameters: z.object({
      agentId: z.string().optional().describe("Filter by agent ID"),
      limit: z.number().optional().describe("Max results (default 50)"),
    }),
    handler: async ({ agentId, limit }) => {
      if (!selectedCompanyId) return "No company selected";
      const result = await heartbeatsApi.list(selectedCompanyId, agentId, limit);
      return JSON.stringify(result.map((r) => ({
        id: r.id,
        status: r.status,
        invocationSource: r.invocationSource,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })));
    },
  });

  useFrontendTool({
    name: "cancelHeartbeatRun",
    description: "Cancel a running agent heartbeat",
    parameters: z.object({
      runId: z.string().describe("Run ID"),
    }),
    handler: async ({ runId }) => {
      await heartbeatsApi.cancel(runId);
      queryClient.invalidateQueries({ queryKey: ["heartbeat-runs"] });
      return "Run cancelled";
    },
  });

  // ── Secrets ───────────────────────────────────────────────────────

  useFrontendTool({
    name: "listSecrets",
    description: "List secrets (API keys, tokens) for the current company. Values are not returned, only metadata.",
    parameters: z.object({}),
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await secretsApi.list(selectedCompanyId);
      return JSON.stringify(result.map((s) => ({ id: s.id, name: s.name, description: s.description, createdAt: s.createdAt })));
    },
  });

  // ── UI Dialogs ────────────────────────────────────────────────────

  useFrontendTool({
    name: "openNewIssueDialog",
    description: "Open the new issue creation dialog with optional pre-filled values",
    parameters: z.object({
      title: z.string().optional().describe("Pre-fill title"),
      description: z.string().optional().describe("Pre-fill description"),
      status: z.string().optional().describe("Pre-fill status"),
      priority: z.string().optional().describe("Pre-fill priority"),
      projectId: z.string().optional().describe("Pre-fill project"),
      assigneeAgentId: z.string().optional().describe("Pre-fill assignee agent"),
    }),
    handler: async (defaults) => {
      const cleaned = Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined));
      openNewIssue(Object.keys(cleaned).length > 0 ? cleaned : undefined);
      return "Opened new issue dialog";
    },
  });

  useFrontendTool({
    name: "openNewProjectDialog",
    description: "Open the new project creation dialog",
    parameters: z.object({}),
    handler: async () => {
      openNewProject();
      return "Opened new project dialog";
    },
  });

  useFrontendTool({
    name: "openNewGoalDialog",
    description: "Open the new goal creation dialog",
    parameters: z.object({
      parentId: z.string().optional().describe("Parent goal ID for sub-goals"),
    }),
    handler: async ({ parentId }) => {
      openNewGoal(parentId ? { parentId } : undefined);
      return "Opened new goal dialog";
    },
  });

  useFrontendTool({
    name: "openNewAgentDialog",
    description: "Open the new agent hiring dialog",
    parameters: z.object({}),
    handler: async () => {
      openNewAgent();
      return "Opened new agent dialog";
    },
  });
}
