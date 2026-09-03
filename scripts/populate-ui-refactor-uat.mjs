// Idempotently populates a disposable project through Paperclip's public API.
const apiBase = (process.env.PAPERCLIP_UAT_API_URL ?? "http://127.0.0.1:3100/api").replace(/\/$/, "");
const companyPrefix = process.env.PAPERCLIP_UAT_COMPANY_PREFIX ?? "TES";
const projectName = process.env.PAPERCLIP_UAT_PROJECT_NAME ?? "UI Refactor UAT";

async function request(path, init) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${text}`);
  }
  return body;
}

async function findOrCreateLabel(companyId, existingLabels, input) {
  const existing = existingLabels.find((label) => label.name === input.name);
  if (existing) return existing;
  const created = await request(`/companies/${companyId}/labels`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  existingLabels.push(created);
  return created;
}

async function findOrCreateTask(companyId, projectId, existingTasks, key, input) {
  const parentId = input.parentId ?? null;
  const existing = existingTasks.find(
    (task) => task.title === input.title && (task.parentId ?? null) === parentId,
  );
  if (existing) return existing;

  const created = await request(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      projectId,
      idempotencyKey: `ui-refactor-uat:${key}`,
      ...input,
    }),
  });
  existingTasks.push(created);
  return created;
}

async function ensureDocument(issueId, key, input) {
  const existing = await request(`/issues/${issueId}/documents`);
  const found = existing.find((document) => document.key === key);
  if (found) return found;
  return request(`/issues/${issueId}/documents/${encodeURIComponent(key)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

async function ensureWorkProduct(issueId, externalId, input) {
  const existing = await request(`/issues/${issueId}/work-products`);
  const found = existing.find((workProduct) => workProduct.externalId === externalId);
  if (found) return found;
  return request(`/issues/${issueId}/work-products`, {
    method: "POST",
    body: JSON.stringify({ externalId, ...input }),
  });
}

const companies = await request("/companies");
const company = companies.find((candidate) => candidate.issuePrefix === companyPrefix);
if (!company) {
  throw new Error(`No company with issue prefix ${companyPrefix} was found.`);
}

const projects = await request(`/companies/${company.id}/projects`);
let project = projects.find((candidate) => candidate.name === projectName);
if (!project) {
  project = await request(`/companies/${company.id}/projects`, {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      description: "Synthetic tasks for UI refactor acceptance testing. Safe to delete as one project after review.",
      status: "in_progress",
      icon: "layers",
    }),
  });
}

const existingTasks = await request(
  `/companies/${company.id}/issues?projectId=${encodeURIComponent(project.id)}&limit=1000`,
);

const existingLabels = await request(`/companies/${company.id}/labels`);
const labels = {};
for (const input of [
  { name: "UAT: customer impact", color: "#DC2626" },
  { name: "UAT: frontend", color: "#2563EB" },
  { name: "UAT: needs decision", color: "#D97706" },
  { name: "UAT: quick win", color: "#16A34A" },
]) {
  const label = await findOrCreateLabel(company.id, existingLabels, input);
  labels[input.name] = label.id;
}

const blocker = await findOrCreateTask(company.id, project.id, existingTasks, "blocker-contract", {
  title: "Confirm the API contract for bulk task updates",
  description: "A short, unassigned blocker used to verify relationship badges, blocked-state filtering, and task-detail navigation.",
  status: "todo",
  priority: "high",
  labelIds: [labels["UAT: needs decision"]],
});

const parent = await findOrCreateTask(company.id, project.id, existingTasks, "parent-mixed-subtasks", {
  title: "Prepare the populated task-list experience for design review",
  description: "Parent task with mixed-state subtasks. Use this task to verify the Subtasks tab, progress summary, relation rows, long chat layout, and task-detail Back behavior.",
  status: "in_progress",
  priority: "high",
  assigneeUserId: "local-board",
  billingCode: "UAT-DESIGN",
  labelIds: [labels["UAT: frontend"], labels["UAT: customer impact"]],
});

const tasks = [
  blocker,
  parent,
  await findOrCreateTask(company.id, project.id, existingTasks, "critical-blocked-long-title", {
    title: "Resolve the blocked checkout experience across a deliberately long task title without hiding status, priority, ownership, or relationship metadata",
    description: "This row is intentionally dense. Confirm truncation is graceful and that the critical priority, blocked state, labels, assignee, and blocker remain understandable.",
    status: "blocked",
    priority: "critical",
    assigneeUserId: "local-board",
    blockedByIssueIds: [blocker.id],
    unblockDescriptor: {
      owner: "board",
      action: "Choose and document the bulk-update API contract.",
    },
    labelIds: [labels["UAT: customer impact"], labels["UAT: needs decision"]],
  }),
  await findOrCreateTask(company.id, project.id, existingTasks, "in-review", {
    title: "Review the shared Inbox and Tasks row presentation",
    description: "Use this item to inspect the in-review state in list and Kanban views.",
    status: "in_review",
    priority: "high",
    assigneeUserId: "local-board",
    labelIds: [labels["UAT: frontend"]],
  }),
  await findOrCreateTask(company.id, project.id, existingTasks, "todo-no-subtasks", {
    title: "Verify a task with no subtasks",
    description: "This task intentionally has no children. Use it to validate the requested conditional Subtasks-tab behavior and the replacement entry point for adding the first subtask.",
    status: "todo",
    priority: "medium",
    labelIds: [labels["UAT: quick win"]],
  }),
  await findOrCreateTask(company.id, project.id, existingTasks, "backlog-unassigned", {
    title: "Explore an unassigned backlog task with minimal metadata",
    description: null,
    status: "backlog",
    priority: "low",
  }),
  await findOrCreateTask(company.id, project.id, existingTasks, "done-metadata", {
    title: "Document the first-pass information architecture decisions",
    description: "Completed item with multiple labels and a billing code for metadata-density review.",
    status: "done",
    priority: "medium",
    assigneeUserId: "local-board",
    billingCode: "UAT-IA",
    labelIds: [labels["UAT: frontend"], labels["UAT: quick win"]],
  }),
  await findOrCreateTask(company.id, project.id, existingTasks, "cancelled", {
    title: "Retire the duplicate navigation experiment",
    description: "Cancelled item included to test muted row treatment and status filtering.",
    status: "cancelled",
    priority: "low",
    labelIds: [labels["UAT: needs decision"]],
  }),
];

for (const child of [
  {
    key: "child-todo",
    title: "Define responsive spacing tokens",
    status: "todo",
    priority: "high",
    labelIds: [labels["UAT: frontend"]],
  },
  {
    key: "child-progress",
    title: "Apply list-density and overflow treatment",
    status: "in_progress",
    priority: "medium",
    assigneeUserId: "local-board",
    labelIds: [labels["UAT: frontend"]],
  },
  {
    key: "child-done",
    title: "Capture the baseline screenshots",
    status: "done",
    priority: "low",
    assigneeUserId: "local-board",
    labelIds: [labels["UAT: quick win"]],
  },
]) {
  const { key, ...childInput } = child;
  tasks.push(await findOrCreateTask(company.id, project.id, existingTasks, key, {
    parentId: parent.id,
    description: `Synthetic ${child.status.replace("_", " ")} subtask for task-detail and progress-summary UAT.`,
    ...childInput,
  }));
}

const reviewNotes = await ensureDocument(parent.id, "uat-review-notes", {
  title: "UAT review notes",
  format: "markdown",
  body: [
    "# UAT review notes",
    "",
    "Use this synthetic document to verify document tabs, truncation, close controls, and tab persistence.",
    "",
    "- Compare Properties, Subtasks, Artifacts, and this document tab.",
    "- Resize the sidebar and confirm tab labels degrade gracefully.",
  ].join("\n"),
  changeSummary: "Seeded for Streamlined UI acceptance testing.",
});

const reviewArtifact = await ensureWorkProduct(
  parent.id,
  "ui-refactor-uat:review-artifact",
  {
    projectId: project.id,
    type: "artifact",
    provider: "custom",
    title: "Streamlined UI review artifact",
    status: "ready_for_review",
    reviewState: "needs_board_review",
    summary: "Synthetic artifact used to exercise the task sidebar's Artifacts tab during UAT.",
  },
);

const summary = {
  company: company.name,
  project: project.name,
  projectId: project.id,
  projectUrl: `/${company.issuePrefix}/projects/${project.urlKey}/issues`,
  seededTaskCount: tasks.length,
  seededDocument: { key: reviewNotes.key, title: reviewNotes.title },
  seededArtifact: { id: reviewArtifact.id, title: reviewArtifact.title },
  tasks: tasks.map(({ identifier, title, status, priority }) => ({ identifier, title, status, priority })),
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
