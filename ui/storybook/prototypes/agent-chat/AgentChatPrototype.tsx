import { useEffect, useLayoutEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentRouteRef } from "@/lib/utils";
import { recordAgentChatVisit } from "@/lib/recent-agent-chats";
import { AgentDetail } from "@/pages/AgentDetail";
import { AgentChat } from "@/pages/AgentChat";
import { IssueDetail } from "@/pages/IssueDetail";
import { Agents, AGENT_FILTER_TABS } from "@/pages/Agents";
import { Layout } from "@/components/Layout";
import { usePanel } from "@/context/PanelContext";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Routes, Route, useNavigate, useLocation } from "@/lib/router";
import type {
  IssueChatComment,
  IssueChatLinkedRun,
} from "@/lib/issue-chat-messages";
import {
  taskPanelArtifactsTab,
  taskPanelDocumentTab,
  taskPanelPropertiesTab,
  taskPanelSubtasksTab,
  writeTaskSidePanelState,
} from "@/lib/task-side-panel-state";
import {
  storybookAgents,
  storybookIssues,
  storybookIssueDocuments,
} from "../../fixtures/paperclipData";
import { chatAgents, chatIdentifier } from "./AgentChatSidebar";

const agent = storybookAgents.find((agent) => agent.id === "agent-codex")!;
const issue = {
  ...storybookIssues[0],
  id: "agent-chat-shared-task",
  identifier: "PAP-241",
  title: "Chat with CodexCoder",
  description: "",
  status: "in_review" as const,
  executionRunId: null,
  checkoutRunId: null,
  executionLockedAt: null,
  assigneeAgentId: agent.id,
  parentId: null,
  blockedBy: [],
  blocks: [],
  labels: [],
  labelIds: [],
  currentExecutionWorkspace: null,
};
const child = {
  ...storybookIssues[0],
  id: "agent-chat-child",
  identifier: "PAP-248",
  title: "Improve the first agent handoff",
  parentId: issue.id,
  status: "todo" as const,
};
const plan = {
  ...storybookIssueDocuments[0],
  issueId: issue.id,
  title: "Launch plan",
  createdAt: new Date("2026-09-10T15:42:15Z"),
  updatedAt: new Date("2026-09-10T15:42:20Z"),
  body: "# A smaller, clearer launch\n\nFocus on the first useful result.\n\n## Listen\nReview the five most recent onboarding conversations and record where people hesitate.\n\n## Improve the first handoff\nGive the first agent one small, useful task. Show its output where the user can open it.\n\n## Invite a small group\nShare the improved flow with ten teams and ask whether they reached a useful result without help.",
};
const notes = {
  ...storybookIssueDocuments[1],
  issueId: issue.id,
  title: "Onboarding notes",
  createdAt: new Date("2026-09-10T15:42:10Z"),
  updatedAt: new Date("2026-09-10T15:42:12Z"),
  body: "# Onboarding notes\n\nPeople understand hiring an agent quickly. The uncertainty starts with what to ask it to do first.\n\n- Give one concrete starting point.\n- Keep the conversation available after work finishes.\n- Put the result beside the conversation.",
};
const runId = "agent-chat-shared-run";
const run: IssueChatLinkedRun = {
  runId,
  status: "succeeded",
  agentId: agent.id,
  agentName: agent.name,
  adapterType: "codex_local",
  createdAt: new Date("2026-09-10T15:42:00Z"),
  startedAt: new Date("2026-09-10T15:42:00Z"),
  finishedAt: new Date("2026-09-10T15:43:00Z"),
  hasStoredOutput: true,
};
const logItems = [
  {
    type: "item.completed",
    item: {
      id: "thinking-1",
      type: "reasoning",
      text: "I’ll review the onboarding notes and separate the launch discussion from the implementation task.",
    },
  },
  {
    type: "item.started",
    item: {
      id: "read-notes",
      type: "command_execution",
      command: "cat onboarding-notes.md",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "read-notes",
      type: "command_execution",
      command: "cat onboarding-notes.md",
      aggregated_output:
        "Users need a clear first task and an inspectable result.",
      status: "completed",
      exit_code: 0,
    },
  },
  {
    type: "item.started",
    item: {
      id: "save-plan",
      type: "command_execution",
      command: "paperclip documents update PAP-241 plan",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "save-plan",
      type: "command_execution",
      command: "paperclip documents update PAP-241 plan",
      aggregated_output: "Saved launch plan revision 3.",
      status: "completed",
      exit_code: 0,
    },
  },
];
function runLogContent() {
  return (
    logItems
      .map((item, index) =>
        JSON.stringify({
          ts: new Date(
            Date.parse("2026-09-10T15:42:00Z") + index * 5000,
          ).toISOString(),
          stream: "stdout",
          seq: index + 1,
          chunk: JSON.stringify(item) + "\n",
        }),
      )
      .join("\n") + "\n"
  );
}

function comment(
  id: string,
  body: string,
  agentReply = false,
): IssueChatComment {
  const createdAt = new Date(
    agentReply ? "2026-09-10T15:43:00Z" : "2026-09-10T15:41:00Z",
  );
  return {
    id,
    companyId: issue.companyId,
    issueId: issue.id,
    body,
    authorType: agentReply ? "agent" : "user",
    authorAgentId: agentReply ? agent.id : null,
    authorUserId: agentReply ? null : "user-board",
    runId: agentReply ? runId : null,
    createdAt,
    updatedAt: createdAt,
    presentation: null,
    metadata: null,
  };
}
const comments = [
  comment(
    "chat-request",
    "I've been thinking about the launch. Are we trying to do too much at once? Help me work through it, and create a task for the implementation.",
  ),
  comment(
    "chat-response",
    "I’d focus on the first useful result: give an agent one clear task, then make its output easy to find.\n\nI saved the **launch plan** and **onboarding notes** alongside this conversation. **PAP-248** tracks the first-handoff implementation separately.\n\nWe can keep thinking through the launch here. What's the first thing you want a new user to understand?",
    true,
  ),
];

type Scenario =
  | "returning"
  | "empty"
  | "working"
  | "paused"
  | "error"
  | "long"
  | "new-session"
  | "disabled"
  | "project-reused"
  | "project-created"
  | "project-multi-repo"
  | "project-no-repo"
  | "project-failed";
export interface AgentChatPrototypeProps {
  scenario?: Scenario;
  contextInitiallyOpen?: boolean;
  taskComparison?: boolean;
}

/** Production pages with an in-memory API. No alternate chat controller. */
export function AgentChatPrototype({
  scenario = "returning",
  contextInitiallyOpen = true,
  taskComparison = false,
}: AgentChatPrototypeProps) {
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { setPanelVisible } = usePanel();
  useEffect(() => {
    setPanelVisible(contextInitiallyOpen);
  }, [contextInitiallyOpen, setPanelVisible]);
  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const chats = new Map<
      string,
      typeof issue & {
        conversationAgentId?: string | null;
        conversationUserId?: string | null;
        conversationState?: "waiting";
      }
    >();
    const messages = new Map<string, IssueChatComment[]>();
    const members = {
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: ["agent-cto"],
      starredDocumentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      documentStarredAt: {},
      updatedAt: null,
    };
    let failSend = scenario === "error";
    let active = scenario === "working";
    const fixtureAgents = chatAgents.map((a) => ({
      ...a,
      status:
        scenario === "paused" && a.id === agent.id
          ? ("paused" as const)
          : a.status,
    }));
    for (const a of fixtureAgents) {
      const task = {
        ...issue,
        id: a.id === agent.id ? issue.id : `chat-task-${a.id}`,
        identifier: chatIdentifier(a.id),
        assigneeAgentId: a.id,
        title: `Chat with ${a.name}`,
        conversationAgentId: taskComparison ? null : a.id,
        conversationUserId: taskComparison ? null : "user-board",
        conversationState: "waiting" as const,
      };
      if (scenario !== "empty" || a.id !== agent.id) chats.set(a.id, task);
      let history =
        a.id === agent.id && scenario !== "empty"
          ? scenario === "working"
            ? comments.slice(0, 1)
            : [...comments]
          : [];
      if (scenario === "long" && a.id === agent.id)
        history = [
          ...Array.from({ length: 24 }, (_, i) => ({
            ...comment(
              `history-${i}`,
              i % 2
                ? "Capture where users hesitate in the onboarding notes."
                : "What should we learn from onboarding?",
              i % 2 === 1,
            ),
            runId: null,
            createdAt: new Date(Date.parse("2026-09-09T12:00:00Z") + i * 60000),
          })),
          ...history,
        ];
      if (scenario === "new-session" && a.id === agent.id)
        history.push({
          ...comment("session-boundary", "/new"),
          conversationSessionGeneration: 1,
          createdAt: new Date("2026-09-10T15:45:00Z"),
        });
      if (scenario.startsWith("project-") && a.id === agent.id) history[history.length - 1] = {
        ...history[history.length - 1], body: scenario === "project-failed"
          ? "Project creation failed because repository access is unavailable. I kept the plan here; no execution task was created."
          : scenario === "project-reused"
          ? "I copied the relevant plan to [PAP-248](/PAP/issues/PAP-248) in the existing Launch project and assigned CodexCoder. The original plan remains here."
          : "I saved the plan here and copied it to [PAP-248](/PAP/issues/PAP-248) in the new project. The assigned task can now begin; we can continue the discussion here.",
      };
      messages.set(task.id, history);
      writeTaskSidePanelState("user-board", task.companyId, task.id, {
        state: {
          tabs: taskComparison
            ? [taskPanelPropertiesTab()]
            : [
                taskPanelDocumentTab("plan", "Launch plan"),
                taskPanelArtifactsTab(),
                taskPanelSubtasksTab(),
              ],
          activeTabId: taskComparison ? "properties" : "document:plan",
        },
        launcherOpen: false,
        userInteracted: true,
        autoPlanHandled: true,
        updatedAt: Date.now(),
      });
    }
    for (const id of ["chat-design", "agent-qa", "agent-codex"])
      recordAgentChatVisit(issue.companyId, "user-board", id);
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.origin,
      );
      const path = url.pathname;
      if (!path.startsWith("/api/")) return originalFetch(input, init);
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const body =
        init?.body && typeof init.body === "string"
          ? JSON.parse(init.body)
          : {};
      const chatRef = path.match(/\/chats\/([^/]+)$/)?.[1];
      if (chatRef) {
        const a = fixtureAgents.find(
          (a) => a.id === chatRef || agentRouteRef(a) === chatRef,
        );
        if (!a)
          return Response.json({ error: "Agent not found" }, { status: 404 });
        if (method === "POST" && !chats.has(a.id))
          chats.set(a.id, {
            ...issue,
            conversationAgentId: a.id,
            conversationUserId: "user-board",
            conversationState: "waiting",
            id: issue.id,
          });
        return Response.json(chats.get(a.id) ?? null);
      }
      const taskRef = path.match(/\/issues\/([^/]+)/)?.[1];
      const task =
        [...chats.values()].find(
          (t) => t.id === taskRef || t.identifier === taskRef,
        ) ?? issue;
      if (path.endsWith("/resource-memberships/me"))
        return Response.json(members);
      if (/resource-memberships\/me\/agents\//.test(path) && method === "PUT") {
        const id = path.split("/").at(-1)!;
        members.starredAgentIds = body.starred
          ? [...new Set([...members.starredAgentIds, id])]
          : members.starredAgentIds.filter((i) => i !== id);
        return Response.json(members);
      }
      if (method === "POST" && path.endsWith("/comments")) {
        if (failSend) {
          failSend = false;
          return Response.json(
            {
              error:
                "Message could not be sent. Retry with your preserved draft.",
            },
            { status: 503 },
          );
        }
        const row = {
          ...comment(crypto.randomUUID(), body.body),
          issueId: task.id,
          clientRequestId: body.clientRequestId,
          createdAt: new Date(
            Math.max(Date.now(), Date.parse("2026-09-10T16:00:00Z")),
          ),
          ...(body.body.trim() === "/new"
            ? { conversationSessionGeneration: 1 }
            : {}),
        };
        messages.set(task.id, [...(messages.get(task.id) ?? []), row]);
        return Response.json(row);
      }
      if (method === "POST" && path.endsWith("/read")) return Response.json({});
      if (method === "PATCH" && /\/issues\/[^/]+$/.test(path)) {
        Object.assign(task, body);
        return Response.json(task);
      }
      if (method === "POST" && path.endsWith("/cancel")) {
        active = false;
        return Response.json({ ...run, status: "cancelled" });
      }
      if (method !== "GET")
        return Response.json(
          {
            error: "This operation is not configured in the Storybook fixture.",
          },
          { status: 422 },
        );
      if (path === "/api/cli-auth/me")
        return Response.json({
          source: "local_implicit",
          isInstanceAdmin: true,
          companyIds: [issue.companyId],
          memberships: [],
        });
      if (path === "/api/instance/settings/experimental")
        return Response.json({
          enableAgentChat: scenario !== "disabled",
          enableStreamlinedUi: true,
          enableClassicTaskInterface: false,
          enableExperimentalFileViewer: true,
        });
      if (path === "/api/instance/settings")
        return Response.json({ experimental: {} });
      if (path === "/api/instance/settings/general") return Response.json({});
      if (path.endsWith("/comments"))
        return Response.json([...(messages.get(task.id) ?? [])].reverse());
      if (path.endsWith("/queued-comments"))
        return Response.json({
          issueId: task.id,
          queueId: null,
          entries: [],
          revision: "empty",
        });
      if (path.endsWith("/tree-control/state"))
        return Response.json({ activePauseHold: null, activeHolds: [] });
      if (path.endsWith("/runs"))
        return Response.json(
          task.id === issue.id && scenario !== "empty"
            ? [
                {
                  ...run,
                  runId,
                  usageJson: null,
                  resultJson: null,
                  logBytes: 2000,
                  status: active ? "running" : "succeeded",
                },
              ]
            : [],
        );
      if (path === `/api/heartbeat-runs/${runId}/log`) {
        const content = runLogContent();
        return Response.json({
          runId,
          store: "fixture",
          logRef: "fixture",
          content: Number(url.searchParams.get("offset") ?? 0) ? "" : content,
          nextOffset: content.length,
        });
      }
      if (path.includes("active-run"))
        return Response.json(
          active ? { ...run, id: runId, status: "running" } : null,
        );
      if (path.endsWith("/live-runs"))
        return Response.json(
          active
            ? [{ ...run, id: runId, issueId: issue.id, status: "running" }]
            : [],
        );
      if (path.endsWith("/activity") && scenario.startsWith("project-") && scenario !== "project-failed" && scenario !== "project-reused") return Response.json([{
        id: "created-project-event", companyId: issue.companyId, actorType: "agent", actorId: agent.id,
        agentId: agent.id, runId, entityType: "project", entityId: "launch-project", action: "project.created",
        createdAt: "2026-09-10T15:42:30Z", details: {
          name: scenario === "project-multi-repo" ? "First agent handoff across the application, documentation, and onboarding service" : "First agent handoff",
          description: "Help new teams get their first useful result.", sourceIssueId: issue.id,
          repositories: scenario === "project-no-repo" ? [] : [
            { id: "1", name: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip" },
            ...(scenario === "project-multi-repo" ? [{ id: "2", name: "paperclipai/onboarding", url: "https://github.com/paperclipai/onboarding" }] : []),
          ],
        },
      }]);
      if (path.endsWith("/documents/plan"))
        return task.id === issue.id && scenario !== "empty"
          ? Response.json(plan)
          : Response.json({ error: "No plan" }, { status: 404 });
      if (path.endsWith("/documents/notes")) return Response.json(notes);
      if (path.endsWith("/documents"))
        return Response.json(
          task.id === issue.id && scenario !== "empty" ? [plan, notes] : [],
        );
      if (/\/issues\/[^/]+$/.test(path))
        return Response.json(
          taskRef === child.id || taskRef === child.identifier ? child : task,
        );
      if (
        /\/companies\/[^/]+\/issues$/.test(path) &&
        (url.searchParams.has("parentId") || url.searchParams.has("descendantOf"))
      )
        return Response.json(scenario === "empty" ? [] : [child]);
      if (/\/companies\/[^/]+\/agents$/.test(path))
        return Response.json(fixtureAgents);
      if (/\/agents\/[^/]+$/.test(path))
        return Response.json(
          fixtureAgents.find(
            (a) => path.endsWith(a.id) || path.endsWith(agentRouteRef(a)),
          ) ?? agent,
        );
      if (/^\/api\/adapters\/[^/]+\/config-schema$/.test(path))
        return Response.json({ error: "No schema override" }, { status: 404 });
      if (
        path === "/api/companies" ||
        path === "/api/auth/get-session" ||
        path === "/api/adapters" ||
        path === "/api/health" ||
        /\/companies\/[^/]+\/(projects|dashboard|sidebar-badges|user-directory|issues|approvals)$/.test(
          path,
        ) ||
        /^\/api\/companies\/[^/]+\/(adapters\/|environments)/.test(path)
      )
        return originalFetch(input, init);
      return Response.json([]);
    };
    queryClient.clear();
    setReady(true);
    return () => {
      window.fetch = originalFetch;
      queryClient.clear();
    };
  }, [scenario, taskComparison, queryClient]);
  useEffect(() => {
    if (ready && location.pathname.endsWith("/storybook"))
      navigate(
        `/PAP/${taskComparison ? `issues/${issue.id}` : "chats/agent-codex"}`,
        { replace: true },
      );
  }, [ready, navigate, location.pathname, taskComparison]);
  if (!ready) return null;
  return (
    <PluginLauncherProvider>
      <Routes>
        <Route path="/:companyPrefix" element={<Layout />}>
          <Route path="chats/:agentRef" element={<AgentChat />} />
          <Route path="issues/:issueId" element={<IssueDetail />} />
          <Route path="agents" element={<Agents />} />
          {AGENT_FILTER_TABS.map((tab) => (
            <Route key={tab} path={`agents/${tab}`} element={<Agents />} />
          ))}
          <Route path="agents/:agentId/:tab" element={<AgentDetail />} />
          <Route path="agents/:agentId" element={<AgentDetail />} />
        </Route>
      </Routes>
    </PluginLauncherProvider>
  );
}
