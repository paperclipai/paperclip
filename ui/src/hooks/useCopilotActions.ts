import { useCopilotAction, useCopilotReadable, useCopilotChatSuggestions } from "@copilotkit/react-core";
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

export function useCopilotActions() {
  const navigate = useNavigate();
  const location = useLocation();
  const { companies, selectedCompany, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewIssue, openNewProject, openNewGoal, openNewAgent } = useDialog();
  const queryClient = useQueryClient();

  // ── Readable context ──────────────────────────────────────────────

  useCopilotReadable({
    description: "System context — you are the Paperclip AI assistant embedded in the Paperclip control-plane dashboard. Paperclip orchestrates AI agent companies with issues, projects, goals, agents, approvals, and budgets. Be concise and action-oriented. Prefer executing actions over lengthy explanations. When referring to entities include their identifier (e.g. ACME-42) when available.",
    value: "Paperclip AI assistant active",
  });

  useCopilotReadable({
    description: "Current page URL path",
    value: location.pathname,
  });

  useCopilotReadable({
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

  useCopilotReadable({
    description: "All companies available to the user",
    value: companies.map((c) => ({ id: c.id, name: c.name, issuePrefix: c.issuePrefix, status: c.status })),
  });

  // ── Chat suggestions ──────────────────────────────────────────────

  useCopilotChatSuggestions({
    instructions: "Suggest 3 relevant actions based on the current page context. Examples: show dashboard summary, list open issues, create a new issue, check agent status, view pending approvals, show cost breakdown. Keep suggestions short (under 8 words).",
    maxSuggestions: 3,
    minSuggestions: 1,
  }, [location.pathname, selectedCompanyId]);

  // ── Navigation ────────────────────────────────────────────────────

  useCopilotAction({
    name: "navigate",
    description: "Navigate to a page in the app. Use issue prefix for company routes (e.g. /ACME/issues, /ACME/agents, /ACME/projects, /ACME/goals, /ACME/approvals, /ACME/costs, /ACME/dashboard, /instance/settings/heartbeats).",
    parameters: [{ name: "path", type: "string", description: "The URL path to navigate to", required: true }],
    handler: async ({ path }) => {
      navigate(path);
      return `Navigated to ${path}`;
    },
  });

  useCopilotAction({
    name: "switchCompany",
    description: "Switch to a different company/workspace",
    parameters: [{ name: "companyId", type: "string", description: "The company ID to switch to", required: true }],
    handler: async ({ companyId }) => {
      setSelectedCompanyId(companyId, { source: "manual" });
      const company = companies.find((c) => c.id === companyId);
      if (company) navigate(`/${company.issuePrefix}/issues`);
      return `Switched to company ${company?.name ?? companyId}`;
    },
  });

  // ── Companies ─────────────────────────────────────────────────────

  useCopilotAction({
    name: "listCompanies",
    description: "List all companies/workspaces",
    parameters: [],
    handler: async () => {
      const result = await companiesApi.list();
      return result.map((c) => ({ id: c.id, name: c.name, issuePrefix: c.issuePrefix, status: c.status, description: c.description }));
    },
  });

  useCopilotAction({
    name: "createCompany",
    description: "Create a new company/workspace",
    parameters: [
      { name: "name", type: "string", description: "Company name", required: true },
      { name: "description", type: "string", description: "Company description" },
      { name: "budgetMonthlyCents", type: "number", description: "Monthly budget in cents" },
    ],
    handler: async ({ name, description, budgetMonthlyCents }) => {
      const result = await companiesApi.create({ name, description, budgetMonthlyCents });
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      return { id: result.id, name: result.name, issuePrefix: result.issuePrefix };
    },
  });

  useCopilotAction({
    name: "updateCompany",
    description: "Update a company's settings",
    parameters: [
      { name: "companyId", type: "string", description: "Company ID", required: true },
      { name: "name", type: "string", description: "New name" },
      { name: "description", type: "string", description: "New description" },
      { name: "budgetMonthlyCents", type: "number", description: "New monthly budget in cents" },
      { name: "status", type: "string", description: "New status" },
    ],
    handler: async ({ companyId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await companiesApi.update(companyId, data);
      queryClient.invalidateQueries({ queryKey: ["companies"] });
      return { id: result.id, name: result.name };
    },
  });

  // ── Issues ────────────────────────────────────────────────────────

  useCopilotAction({
    name: "listIssues",
    description: "List issues for the current company. Can filter by status, project, assignee, or search query.",
    parameters: [
      { name: "status", type: "string", description: "Filter by status (backlog, todo, in_progress, in_review, done, cancelled)" },
      { name: "projectId", type: "string", description: "Filter by project ID" },
      { name: "assigneeAgentId", type: "string", description: "Filter by assigned agent ID" },
      { name: "q", type: "string", description: "Search query" },
    ],
    handler: async ({ status, projectId, assigneeAgentId, q }) => {
      if (!selectedCompanyId) return "No company selected";
      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (projectId) filters.projectId = projectId;
      if (assigneeAgentId) filters.assigneeAgentId = assigneeAgentId;
      if (q) filters.q = q;
      const result = await issuesApi.list(selectedCompanyId, filters);
      return result.map((i) => ({
        id: i.id,
        identifier: i.identifier,
        title: i.title,
        status: i.status,
        priority: i.priority,
        assigneeAgentId: i.assigneeAgentId,
        projectId: i.projectId,
      }));
    },
  });

  useCopilotAction({
    name: "getIssue",
    description: "Get full details of a specific issue",
    parameters: [{ name: "issueId", type: "string", description: "The issue ID", required: true }],
    handler: async ({ issueId }) => {
      return await issuesApi.get(issueId);
    },
  });

  useCopilotAction({
    name: "createIssue",
    description: "Create a new issue/task",
    parameters: [
      { name: "title", type: "string", description: "Issue title", required: true },
      { name: "description", type: "string", description: "Issue description (markdown)" },
      { name: "status", type: "string", description: "Status: backlog, todo, in_progress, in_review, done, cancelled" },
      { name: "priority", type: "string", description: "Priority: none, low, medium, high, urgent" },
      { name: "projectId", type: "string", description: "Project ID to assign to" },
      { name: "assigneeAgentId", type: "string", description: "Agent ID to assign" },
      { name: "goalId", type: "string", description: "Goal ID to link to" },
    ],
    handler: async ({ title, description, status, priority, projectId, assigneeAgentId, goalId }) => {
      if (!selectedCompanyId) return "No company selected";
      const data: Record<string, unknown> = { title };
      if (description) data.description = description;
      if (status) data.status = status;
      if (priority) data.priority = priority;
      if (projectId) data.projectId = projectId;
      if (assigneeAgentId) data.assigneeAgentId = assigneeAgentId;
      if (goalId) data.goalId = goalId;
      const result = await issuesApi.create(selectedCompanyId, data);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      return { id: result.id, identifier: result.identifier, title: result.title, status: result.status };
    },
  });

  useCopilotAction({
    name: "updateIssue",
    description: "Update an existing issue",
    parameters: [
      { name: "issueId", type: "string", description: "Issue ID", required: true },
      { name: "title", type: "string", description: "New title" },
      { name: "description", type: "string", description: "New description" },
      { name: "status", type: "string", description: "New status" },
      { name: "priority", type: "string", description: "New priority" },
      { name: "projectId", type: "string", description: "New project ID" },
      { name: "assigneeAgentId", type: "string", description: "New assignee agent ID" },
      { name: "goalId", type: "string", description: "New goal ID" },
    ],
    handler: async ({ issueId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await issuesApi.update(issueId, data);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      return { id: result.id, identifier: result.identifier, title: result.title, status: result.status };
    },
  });

  useCopilotAction({
    name: "addIssueComment",
    description: "Add a comment to an issue",
    parameters: [
      { name: "issueId", type: "string", description: "Issue ID", required: true },
      { name: "body", type: "string", description: "Comment body (markdown)", required: true },
      { name: "reopen", type: "boolean", description: "Whether to reopen the issue if closed" },
    ],
    handler: async ({ issueId, body, reopen }) => {
      const result = await issuesApi.addComment(issueId, body, reopen);
      queryClient.invalidateQueries({ queryKey: ["issues", issueId] });
      return { id: result.id, body: result.body };
    },
  });

  useCopilotAction({
    name: "listIssueComments",
    description: "List all comments on an issue",
    parameters: [{ name: "issueId", type: "string", description: "Issue ID", required: true }],
    handler: async ({ issueId }) => {
      return await issuesApi.listComments(issueId);
    },
  });

  useCopilotAction({
    name: "deleteIssue",
    description: "Delete an issue",
    parameters: [{ name: "issueId", type: "string", description: "Issue ID", required: true }],
    handler: async ({ issueId }) => {
      await issuesApi.remove(issueId);
      queryClient.invalidateQueries({ queryKey: ["issues"] });
      return "Issue deleted";
    },
  });

  // ── Issue Labels ──────────────────────────────────────────────────

  useCopilotAction({
    name: "listLabels",
    description: "List all issue labels for the current company",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return await issuesApi.listLabels(selectedCompanyId);
    },
  });

  useCopilotAction({
    name: "createLabel",
    description: "Create a new issue label",
    parameters: [
      { name: "name", type: "string", description: "Label name", required: true },
      { name: "color", type: "string", description: "Label color (hex)", required: true },
    ],
    handler: async ({ name, color }) => {
      if (!selectedCompanyId) return "No company selected";
      return await issuesApi.createLabel(selectedCompanyId, { name, color });
    },
  });

  // ── Projects ──────────────────────────────────────────────────────

  useCopilotAction({
    name: "listProjects",
    description: "List all projects for the current company",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await projectsApi.list(selectedCompanyId);
      return result.map((p) => ({
        id: p.id,
        name: p.name,
        urlKey: p.urlKey,
        status: p.status,
        description: p.description,
        leadAgentId: p.leadAgentId,
        targetDate: p.targetDate,
      }));
    },
  });

  useCopilotAction({
    name: "getProject",
    description: "Get full details of a project",
    parameters: [{ name: "projectId", type: "string", description: "Project ID", required: true }],
    handler: async ({ projectId }) => {
      return await projectsApi.get(projectId);
    },
  });

  useCopilotAction({
    name: "createProject",
    description: "Create a new project",
    parameters: [
      { name: "name", type: "string", description: "Project name", required: true },
      { name: "description", type: "string", description: "Project description" },
      { name: "leadAgentId", type: "string", description: "Lead agent ID" },
      { name: "targetDate", type: "string", description: "Target date (YYYY-MM-DD)" },
    ],
    handler: async ({ name, description, leadAgentId, targetDate }) => {
      if (!selectedCompanyId) return "No company selected";
      const data: Record<string, unknown> = { name };
      if (description) data.description = description;
      if (leadAgentId) data.leadAgentId = leadAgentId;
      if (targetDate) data.targetDate = targetDate;
      const result = await projectsApi.create(selectedCompanyId, data);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      return { id: result.id, name: result.name, urlKey: result.urlKey };
    },
  });

  useCopilotAction({
    name: "updateProject",
    description: "Update a project",
    parameters: [
      { name: "projectId", type: "string", description: "Project ID", required: true },
      { name: "name", type: "string", description: "New name" },
      { name: "description", type: "string", description: "New description" },
      { name: "status", type: "string", description: "New status (planned, active, paused, completed, cancelled)" },
      { name: "leadAgentId", type: "string", description: "New lead agent ID" },
      { name: "targetDate", type: "string", description: "New target date" },
    ],
    handler: async ({ projectId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await projectsApi.update(projectId, data);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      return { id: result.id, name: result.name, status: result.status };
    },
  });

  useCopilotAction({
    name: "deleteProject",
    description: "Delete a project",
    parameters: [{ name: "projectId", type: "string", description: "Project ID", required: true }],
    handler: async ({ projectId }) => {
      await projectsApi.remove(projectId);
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      return "Project deleted";
    },
  });

  // ── Goals ─────────────────────────────────────────────────────────

  useCopilotAction({
    name: "listGoals",
    description: "List all goals for the current company",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await goalsApi.list(selectedCompanyId);
      return result.map((g) => ({
        id: g.id,
        title: g.title,
        status: g.status,
        level: g.level,
        description: g.description,
        parentId: g.parentId,
        ownerAgentId: g.ownerAgentId,
      }));
    },
  });

  useCopilotAction({
    name: "createGoal",
    description: "Create a new goal",
    parameters: [
      { name: "title", type: "string", description: "Goal title", required: true },
      { name: "description", type: "string", description: "Goal description" },
      { name: "level", type: "string", description: "Goal level (company, team, individual)" },
      { name: "parentId", type: "string", description: "Parent goal ID for sub-goals" },
      { name: "ownerAgentId", type: "string", description: "Owner agent ID" },
    ],
    handler: async ({ title, description, level, parentId, ownerAgentId }) => {
      if (!selectedCompanyId) return "No company selected";
      const data: Record<string, unknown> = { title };
      if (description) data.description = description;
      if (level) data.level = level;
      if (parentId) data.parentId = parentId;
      if (ownerAgentId) data.ownerAgentId = ownerAgentId;
      const result = await goalsApi.create(selectedCompanyId, data);
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      return { id: result.id, title: result.title, status: result.status };
    },
  });

  useCopilotAction({
    name: "updateGoal",
    description: "Update a goal",
    parameters: [
      { name: "goalId", type: "string", description: "Goal ID", required: true },
      { name: "title", type: "string", description: "New title" },
      { name: "description", type: "string", description: "New description" },
      { name: "status", type: "string", description: "New status (active, completed, cancelled)" },
      { name: "ownerAgentId", type: "string", description: "New owner agent ID" },
    ],
    handler: async ({ goalId, ...updates }) => {
      const data = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const result = await goalsApi.update(goalId, data);
      queryClient.invalidateQueries({ queryKey: ["goals"] });
      return { id: result.id, title: result.title, status: result.status };
    },
  });

  // ── Agents ────────────────────────────────────────────────────────

  useCopilotAction({
    name: "listAgents",
    description: "List all agents for the current company",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await agentsApi.list(selectedCompanyId);
      return result.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        title: a.title,
        status: a.status,
        adapterType: a.adapterType,
        reportsTo: a.reportsTo,
      }));
    },
  });

  useCopilotAction({
    name: "getAgent",
    description: "Get full details of an agent",
    parameters: [{ name: "agentId", type: "string", description: "Agent ID", required: true }],
    handler: async ({ agentId }) => {
      return await agentsApi.get(agentId);
    },
  });

  useCopilotAction({
    name: "getAgentOrgChart",
    description: "Get the org chart (reporting hierarchy) for the current company",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return await agentsApi.org(selectedCompanyId);
    },
  });

  useCopilotAction({
    name: "pauseAgent",
    description: "Pause an agent so it stops processing tasks",
    parameters: [{ name: "agentId", type: "string", description: "Agent ID", required: true }],
    handler: async ({ agentId }) => {
      const result = await agentsApi.pause(agentId);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      return { id: result.id, name: result.name, status: result.status };
    },
  });

  useCopilotAction({
    name: "resumeAgent",
    description: "Resume a paused agent",
    parameters: [{ name: "agentId", type: "string", description: "Agent ID", required: true }],
    handler: async ({ agentId }) => {
      const result = await agentsApi.resume(agentId);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      return { id: result.id, name: result.name, status: result.status };
    },
  });

  useCopilotAction({
    name: "terminateAgent",
    description: "Terminate an agent permanently",
    parameters: [{ name: "agentId", type: "string", description: "Agent ID", required: true }],
    handler: async ({ agentId }) => {
      const result = await agentsApi.terminate(agentId);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      return { id: result.id, name: result.name, status: result.status };
    },
  });

  useCopilotAction({
    name: "invokeAgent",
    description: "Trigger an agent heartbeat/run manually",
    parameters: [{ name: "agentId", type: "string", description: "Agent ID", required: true }],
    handler: async ({ agentId }) => {
      const result = await agentsApi.invoke(agentId);
      queryClient.invalidateQueries({ queryKey: ["heartbeat-runs"] });
      return { runId: result.id, status: result.status };
    },
  });

  useCopilotAction({
    name: "wakeupAgent",
    description: "Wake up an agent with a specific trigger",
    parameters: [
      { name: "agentId", type: "string", description: "Agent ID", required: true },
      { name: "reason", type: "string", description: "Reason for waking up the agent" },
    ],
    handler: async ({ agentId, reason }) => {
      const result = await agentsApi.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason });
      return result;
    },
  });

  useCopilotAction({
    name: "getAgentRuntimeState",
    description: "Get the runtime state of an agent (session info, task sessions)",
    parameters: [{ name: "agentId", type: "string", description: "Agent ID", required: true }],
    handler: async ({ agentId }) => {
      return await agentsApi.runtimeState(agentId);
    },
  });

  // ── Approvals ─────────────────────────────────────────────────────

  useCopilotAction({
    name: "listApprovals",
    description: "List approvals for the current company",
    parameters: [
      { name: "status", type: "string", description: "Filter by status (pending, approved, rejected, revision_requested)" },
    ],
    handler: async ({ status }) => {
      if (!selectedCompanyId) return "No company selected";
      const result = await approvalsApi.list(selectedCompanyId, status);
      return result.map((a) => ({
        id: a.id,
        type: a.type,
        status: a.status,
        requestedByAgentId: a.requestedByAgentId,
        decisionNote: a.decisionNote,
        createdAt: a.createdAt,
      }));
    },
  });

  useCopilotAction({
    name: "getApproval",
    description: "Get full details of an approval request",
    parameters: [{ name: "approvalId", type: "string", description: "Approval ID", required: true }],
    handler: async ({ approvalId }) => {
      return await approvalsApi.get(approvalId);
    },
  });

  useCopilotAction({
    name: "approveApproval",
    description: "Approve an approval request",
    parameters: [
      { name: "approvalId", type: "string", description: "Approval ID", required: true },
      { name: "decisionNote", type: "string", description: "Note explaining the decision" },
    ],
    handler: async ({ approvalId, decisionNote }) => {
      const result = await approvalsApi.approve(approvalId, decisionNote);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return { id: result.id, status: result.status };
    },
  });

  useCopilotAction({
    name: "rejectApproval",
    description: "Reject an approval request",
    parameters: [
      { name: "approvalId", type: "string", description: "Approval ID", required: true },
      { name: "decisionNote", type: "string", description: "Note explaining the rejection" },
    ],
    handler: async ({ approvalId, decisionNote }) => {
      const result = await approvalsApi.reject(approvalId, decisionNote);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return { id: result.id, status: result.status };
    },
  });

  useCopilotAction({
    name: "requestApprovalRevision",
    description: "Request revision on an approval",
    parameters: [
      { name: "approvalId", type: "string", description: "Approval ID", required: true },
      { name: "decisionNote", type: "string", description: "Note explaining what needs revision" },
    ],
    handler: async ({ approvalId, decisionNote }) => {
      const result = await approvalsApi.requestRevision(approvalId, decisionNote);
      queryClient.invalidateQueries({ queryKey: ["approvals"] });
      return { id: result.id, status: result.status };
    },
  });

  // ── Dashboard & Costs ─────────────────────────────────────────────

  useCopilotAction({
    name: "getDashboard",
    description: "Get the dashboard summary for the current company (issue counts, agent activity, etc.)",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return await dashboardApi.summary(selectedCompanyId);
    },
  });

  useCopilotAction({
    name: "getCostSummary",
    description: "Get cost summary for the current company",
    parameters: [
      { name: "from", type: "string", description: "Start date (YYYY-MM-DD)" },
      { name: "to", type: "string", description: "End date (YYYY-MM-DD)" },
    ],
    handler: async ({ from, to }) => {
      if (!selectedCompanyId) return "No company selected";
      return await costsApi.summary(selectedCompanyId, from, to);
    },
  });

  useCopilotAction({
    name: "getCostsByAgent",
    description: "Get cost breakdown by agent for the current company",
    parameters: [
      { name: "from", type: "string", description: "Start date (YYYY-MM-DD)" },
      { name: "to", type: "string", description: "End date (YYYY-MM-DD)" },
    ],
    handler: async ({ from, to }) => {
      if (!selectedCompanyId) return "No company selected";
      return await costsApi.byAgent(selectedCompanyId, from, to);
    },
  });

  useCopilotAction({
    name: "getCostsByProject",
    description: "Get cost breakdown by project for the current company",
    parameters: [
      { name: "from", type: "string", description: "Start date (YYYY-MM-DD)" },
      { name: "to", type: "string", description: "End date (YYYY-MM-DD)" },
    ],
    handler: async ({ from, to }) => {
      if (!selectedCompanyId) return "No company selected";
      return await costsApi.byProject(selectedCompanyId, from, to);
    },
  });

  // ── Activity ──────────────────────────────────────────────────────

  useCopilotAction({
    name: "listActivity",
    description: "List recent activity events for the current company",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      return await activityApi.list(selectedCompanyId);
    },
  });

  useCopilotAction({
    name: "getIssueActivity",
    description: "Get activity history for a specific issue",
    parameters: [{ name: "issueId", type: "string", description: "Issue ID", required: true }],
    handler: async ({ issueId }) => {
      return await activityApi.forIssue(issueId);
    },
  });

  // ── Heartbeat Runs ────────────────────────────────────────────────

  useCopilotAction({
    name: "listHeartbeatRuns",
    description: "List agent heartbeat runs (execution history) for the current company",
    parameters: [
      { name: "agentId", type: "string", description: "Filter by agent ID" },
      { name: "limit", type: "number", description: "Max results (default 50)" },
    ],
    handler: async ({ agentId, limit }) => {
      if (!selectedCompanyId) return "No company selected";
      const result = await heartbeatsApi.list(selectedCompanyId, agentId, limit);
      return result.map((r) => ({
        id: r.id,
        status: r.status,
        invocationSource: r.invocationSource,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      }));
    },
  });

  useCopilotAction({
    name: "cancelHeartbeatRun",
    description: "Cancel a running agent heartbeat",
    parameters: [{ name: "runId", type: "string", description: "Run ID", required: true }],
    handler: async ({ runId }) => {
      await heartbeatsApi.cancel(runId);
      queryClient.invalidateQueries({ queryKey: ["heartbeat-runs"] });
      return "Run cancelled";
    },
  });

  // ── Secrets ───────────────────────────────────────────────────────

  useCopilotAction({
    name: "listSecrets",
    description: "List secrets (API keys, tokens) for the current company. Values are not returned, only metadata.",
    parameters: [],
    handler: async () => {
      if (!selectedCompanyId) return "No company selected";
      const result = await secretsApi.list(selectedCompanyId);
      return result.map((s) => ({ id: s.id, name: s.name, description: s.description, createdAt: s.createdAt }));
    },
  });

  useCopilotAction({
    name: "createSecret",
    description: "Create a new secret (API key, token, etc.)",
    parameters: [
      { name: "name", type: "string", description: "Secret name (e.g. OPENAI_API_KEY)", required: true },
      { name: "value", type: "string", description: "Secret value", required: true },
      { name: "description", type: "string", description: "Description of what this secret is for" },
    ],
    handler: async ({ name, value, description }) => {
      if (!selectedCompanyId) return "No company selected";
      const result = await secretsApi.create(selectedCompanyId, { name, value, description });
      queryClient.invalidateQueries({ queryKey: ["secrets"] });
      return { id: result.id, name: result.name };
    },
  });

  // ── UI Dialogs ────────────────────────────────────────────────────

  useCopilotAction({
    name: "openNewIssueDialog",
    description: "Open the new issue creation dialog with optional pre-filled values",
    parameters: [
      { name: "title", type: "string", description: "Pre-fill title" },
      { name: "description", type: "string", description: "Pre-fill description" },
      { name: "status", type: "string", description: "Pre-fill status" },
      { name: "priority", type: "string", description: "Pre-fill priority" },
      { name: "projectId", type: "string", description: "Pre-fill project" },
      { name: "assigneeAgentId", type: "string", description: "Pre-fill assignee agent" },
    ],
    handler: async (defaults) => {
      const cleaned = Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined));
      openNewIssue(Object.keys(cleaned).length > 0 ? cleaned : undefined);
      return "Opened new issue dialog";
    },
  });

  useCopilotAction({
    name: "openNewProjectDialog",
    description: "Open the new project creation dialog",
    parameters: [],
    handler: async () => {
      openNewProject();
      return "Opened new project dialog";
    },
  });

  useCopilotAction({
    name: "openNewGoalDialog",
    description: "Open the new goal creation dialog",
    parameters: [{ name: "parentId", type: "string", description: "Parent goal ID for sub-goals" }],
    handler: async ({ parentId }) => {
      openNewGoal(parentId ? { parentId } : undefined);
      return "Opened new goal dialog";
    },
  });

  useCopilotAction({
    name: "openNewAgentDialog",
    description: "Open the new agent hiring dialog",
    parameters: [],
    handler: async () => {
      openNewAgent();
      return "Opened new agent dialog";
    },
  });
}
