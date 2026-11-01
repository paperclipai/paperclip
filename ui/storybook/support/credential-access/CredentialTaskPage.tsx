import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/Layout";
import { IssueDetail } from "@/pages/IssueDetail";
import { AgentDetail } from "@/pages/AgentDetail";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { Navigate, Route, Routes } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { seedIssueDetailCache } from "@/lib/issueDetailCache";
import { storybookAgents, storybookIssues, storybookAuthSession } from "../../fixtures/paperclipData";
import type { IssueChatComment, IssueChatLinkedRun } from "@/lib/issue-chat-messages";

export function CredentialTaskPage({ otherPerson = false, runtimeMode = "native", newerAttempt = false }: {
  otherPerson?: boolean; runtimeMode?: "legacy" | "native"; newerAttempt?: boolean;
}) {
  const client = useQueryClient();
  const [fixture] = useState(() => {
    const agent = { ...storybookAgents[0]!, name: "Codie", urlKey: "codie", status: "idle" as const,
      adapterType: runtimeMode === "native" ? "paperclip_runner" : "codex_local" };
    const task = { ...storybookIssues[0]!, id: "credential-task-demo", identifier: "PAP-389",
      title: "Use task names in Slack notifications", description: null, status: "blocked" as const,
      assigneeAgentId: agent.id, assigneeUserId: null, projectId: null, parentId: null,
      executionRunId: null, checkoutRunId: null, executionLockedAt: null,
      labels: [], labelIds: [],
      blockedBy: [], blocks: [], ancestors: [], documentSummaries: [], activeRecoveryAction: null,
      planDocument: null, successfulRunHandoff: null, currentExecutionWorkspace: null,
    };
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const comments: IssueChatComment[] = [{
      id: "credential-comment", companyId: task.companyId, issueId: task.id,
      authorType: "user", authorUserId: otherPerson ? "nicky" : "user-board", authorAgentId: null,
      body: "I just saw a similar bug where we use the task ID rather than the human-friendly task name. Confirm whether your earlier fix addresses this bug. If not, implement a fix and open a PR.",
      presentation: null, metadata: null, createdAt: new Date(ago(4)), updatedAt: new Date(ago(4)),
    }, {
      id: "credential-retry-comment", companyId: task.companyId, issueId: task.id,
      authorType: "user", authorUserId: otherPerson ? "nicky" : "user-board", authorAgentId: null,
      body: "I tried reconnecting my OpenAI subscription but Codie still won’t run for me.",
      presentation: null, metadata: null, createdAt: new Date(ago(2)), updatedAt: new Date(ago(2)),
    }];
    const run: IssueChatLinkedRun = {
      runId: "credential-run", agentId: agent.id, agentName: agent.name, adapterType: agent.adapterType,
      responsibleUserId: otherPerson ? "nicky" : "user-board", runtimeMode, status: "failed",
      errorCode: "configuration_incomplete", error: "This credential is not shared with the responsible user",
      createdAt: ago(1), startedAt: null, finishedAt: ago(1), hasStoredOutput: false,
      resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared",
        credentialAccess: { connectionName: "Dotta’s API Key" } } },
    };
    const runs = newerAttempt ? [run, { ...run, runId: "newer-run", status: "succeeded", errorCode: null, error: null,
      createdAt: ago(0.5), startedAt: ago(0.5), finishedAt: ago(0.1), resultJson: null }] : [run];
    if (newerAttempt) comments.push({ ...comments[0]!, id: "credential-success-comment", authorType: "agent",
      authorUserId: null, authorAgentId: agent.id, body: "The notification now uses the task’s title. I checked the task link and opened the fix for review.",
      runId: "newer-run", createdAt: new Date(ago(0.1)), updatedAt: new Date(ago(0.1)) });
    seedIssueDetailCache(client, task);
    client.setQueryData(queryKeys.auth.session, { ...storybookAuthSession,
      user: { ...storybookAuthSession.user, name: otherPerson ? "Dotta" : "Nicky" } });
    client.setQueryData(queryKeys.agents.list(task.companyId), [agent, ...storybookAgents.slice(1)]);
    client.setQueryData(queryKeys.liveRuns(task.companyId), []);
    client.setQueryData(["email-thread", task.companyId, task.id], null);
    for (const ref of [task.id, task.identifier]) {
      client.setQueryData(["email-thread", task.companyId, ref], null);
      client.setQueryData(queryKeys.issues.comments(ref), { pages: [[...comments].reverse()], pageParams: [null] });
      client.setQueryData(queryKeys.issues.runs(ref), runs);
      client.setQueryData(queryKeys.issues.documents(ref), []);
      client.setQueryData([...queryKeys.issues.documents(ref), "plan"], null);
      client.setQueryData(queryKeys.issues.liveRuns(ref), []);
      client.setQueryData(queryKeys.issues.activeRun(ref), null);
      client.setQueryData(["issues", "tree-control-state", ref], { activePauseHold: null });
    }
    const originalFetch = window.fetch;
    const fetchFixture: typeof fetch = async (input, init) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, window.location.origin);
      if (url.pathname === `/api/companies/${task.companyId}/agents`) return Response.json([agent, ...storybookAgents.slice(1)]);
      if (url.pathname === `/api/companies/${task.companyId}/live-runs`) return Response.json([]);
      if ([task.id, task.identifier].some(ref => url.pathname === `/api/companies/${task.companyId}/email/tasks/${ref}`)) return Response.json(null);
      if (url.pathname === `/api/agents/${agent.id}` || url.pathname === "/api/agents/codie") return Response.json(agent);
      const runResource = url.pathname.match(/^\/api\/heartbeat-runs\/(credential-run|newer-run)\/(events|log)$/);
      if (runResource?.[2] === "events") return Response.json([]);
      if (runResource?.[2] === "log") return Response.json({ runId: runResource[1], store: "local", logRef: "storybook", content: "", nextOffset: 0 });
      if (url.pathname === `/api/companies/${task.companyId}/user-directory`) return Response.json({ users: [
        { principalId: "user-board", status: "active", user: { id: "user-board", name: otherPerson ? "Dotta" : "Nicky", email: "board@example.test", image: null } },
        { principalId: "nicky", status: "active", user: { id: "nicky", name: "Nicky", email: "nicky@example.test", image: null } },
      ] });
      const match = url.pathname.match(/^\/api\/issues\/([^/]+)(?:\/(.*))?$/);
      if (match && [task.id, task.identifier].includes(match[1]!)) {
        const resource = match[2] ?? "";
        if (!resource) return Response.json(task);
        if (resource === "comments") return Response.json([...comments].reverse());
        if (resource === "runs") return Response.json(runs);
        if (resource === "active-run") return Response.json(null);
        if (resource === "documents/plan") return Response.json({ error: "No plan" }, { status: 404 });
        if (resource === "tree-control/state") return Response.json({ activePauseHold: null });
        if (resource === "read") return Response.json({ ok: true });
        return Response.json([]);
      }
      return originalFetch(input, init);
    };
    window.fetch = fetchFixture;
    return { task, restore: () => { if (window.fetch === fetchFixture) window.fetch = originalFetch; } };
  });
  useEffect(() => fixture.restore, [fixture]);
  return <PluginLauncherProvider><Routes>
    <Route path="/:companyPrefix" element={<Layout />}>
      <Route path="issues/:issueId" element={<IssueDetail />} />
      <Route path="agents/:agentId/*" element={<AgentDetail />} />
    </Route>
    <Route path="*" element={<Navigate to={`/PAP/issues/${fixture.task.identifier}`} replace />} />
  </Routes></PluginLauncherProvider>;
}
