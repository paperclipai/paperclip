// Deterministic provider: all effects use the real run-authenticated APIs/MCP transport.
// No DB writes, mocked Paperclip responses, provider calls, or outside workspaces.
const base = process.env.PAPERCLIP_API_URL;
const headers = {
  Authorization: `Bearer ${process.env.PAPERCLIP_API_KEY}`,
  "Content-Type": "application/json",
};
async function api(path, method = "GET", body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      `${method} ${path}: ${response.status} ${JSON.stringify(data)}`,
    );
  return data;
}
const run = await api(`/heartbeat-runs/${process.env.PAPERCLIP_RUN_ID}`);
const ctx = run.contextSnapshot;
const task = await api(`/issues/${ctx.issueId}`);
const comment = async (body) =>
  api(`/issues/${task.id}/comments`, "POST", { body });
if (!task.conversationAgentId) {
  const plan = await api(`/issues/${task.id}/documents/plan`);
  await api(`/issues/${task.id}/documents/output`, "PUT", {
    title: "Output",
    format: "markdown",
    body: `Execution received plan: ${plan.body}`,
  });
  await api(`/issues/${task.id}`, "PATCH", {
    status: "done",
    comment: "Execution finished with its initial plan.",
  });
  process.exit(0);
}
const comments = await api(`/issues/${task.id}/comments?order=asc`);
const current =
  comments.find((c) => c.id === ctx.wakeCommentId) ??
  comments.filter((c) => c.authorUserId).at(-1);
let command;
try {
  command = JSON.parse(
    current.body.startsWith("fixture:")
      ? Buffer.from(current.body.slice(8), "base64url").toString()
      : current.body,
  );
} catch {
  command = { action: "reply", text: current.body };
}
if (
  ctx.interactionKind === "request_confirmation" &&
  ctx.interactionStatus === "accepted"
) {
  const plan = await api(`/issues/${task.id}/documents/plan`);
  command = {
    action: "handoff",
    plan: plan.body,
    name: "Approved plan project",
    key: ctx.interactionId,
  };
}
if (ctx.interactionKind === "ask_user_questions")
  command = { action: "reply", text: "Clarification received." };
const writePlan = async (body) => {
  const documents = await api(`/issues/${task.id}/documents`);
  const previous = documents.find((doc) => doc.key === "plan");
  return api(`/issues/${task.id}/documents/plan`, "PUT", {
    title: "Plan",
    format: "markdown",
    body,
    baseRevisionId: previous?.latestRevisionId,
  });
};
const mcp = async (name, args) => {
  const result = await api("/mcp/project-tools", "POST", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (result.result?.isError || result.error)
    throw new Error(JSON.stringify(result));
  return result.result.structuredContent;
};
console.log("Deterministic chat provider received a turn");
if (command.action === "hold") {
  await comment("Provider is streaming and ready to stop.");
  // Keep a real provider process alive so Stop exercises cancellation and tree holds.
  setInterval(() => console.log("Streaming discussion"), 250);
} else if (command.action === "delayed") {
  await comment("Turn started before feature disable.");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await comment("Active turn settled after feature disable.");
} else if (command.action === "project" || command.action === "handoff") {
  try {
    const args = {
      name: command.name ?? "Fixture project",
      repositoryUrls: command.urls,
      repositoryIds: command.ids,
      workspace: command.workspace,
      idempotencyKey: command.key ?? current.id,
    };
    const project = command.projectId
      ? await api(`/projects/${command.projectId}`)
      : command.direct
        ? await api(`/companies/${task.companyId}/projects`, "POST", args)
        : await mcp("create_project", args);
    const retry = command.projectId
      ? project
      : await mcp("create_project", args);
    if (retry.id !== project.id)
      throw new Error("Project retry created a duplicate");
    if (command.action === "handoff") {
      const plan = command.plan ?? "# Plan\n\nWrite the welcome note.";
      if (!ctx.interactionId) await writePlan(plan);
      const tasks = [];
      for (let index = 0; index < (command.split ? 2 : 1); index++) {
        const input = {
          title: `Execution ${index + 1}`,
          projectId: project.id,
          initialPlan: `${plan}\nPart ${index + 1}`,
          idempotencyKey: `${current.id}-${index}`,
        };
        const child = await mcp("create_task", input);
        const again = await mcp("create_task", input);
        if (again.id !== child.id)
          throw new Error("Task retry created a duplicate");
        tasks.push(`[${child.identifier}](/issues/${child.id})`);
      }
      await comment(`Handed off: ${tasks.join(", ")}`);
    } else await comment(`Project registered: ${project.name}`);
  } catch (error) {
    await comment(`Expected tool result: ${error.message}`);
  }
} else if (command.action === "plan") {
  const plan = await writePlan(command.text);
  if (command.approval)
    await api(`/issues/${task.id}/interactions`, "POST", {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Hand this plan off to an assigned project task?",
        acceptLabel: "Approve handoff",
        rejectLabel: "Revise",
        rejectRequiresReason: true,
        target: {
          type: "issue_document",
          key: "plan",
          revisionId: plan.latestRevisionId,
          revisionNumber: plan.latestRevisionNumber,
        },
      },
    });
  await comment("The draft plan is ready for discussion.");
} else if (command.action === "question") {
  await api(`/issues/${task.id}/interactions`, "POST", {
    kind: "ask_user_questions",
    idempotencyKey: current.id,
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      questions: [
        {
          id: "audience",
          prompt: "Who is the welcome note for?",
          selectionMode: "single",
          required: true,
          options: [
            { id: "garden", label: "Garden club" },
            { id: "book", label: "Book club" },
          ],
        },
      ],
    },
  });
  await comment("Please choose an audience.");
} else if (command.action === "history") {
  for (let index = 0; index < 65; index++)
    await comment(`History message ${String(index).padStart(2, "0")}`);
} else {
  await comment(
    `Reply generation ${ctx.conversationSessionGeneration}: ${command.text}`,
  );
}
