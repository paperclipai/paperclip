import { instanceExperimentalSettingsSchema } from "@paperclipai/shared";
import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookAgents,
  storybookAuthSession,
  storybookCompanies,
  storybookIssues,
  storybookProjects,
} from "./paperclipData";
import {
  createWorkFolderFixture,
  WORK_FOLDER_COMPANY,
  type WorkFolderScenario,
} from "./workFolders";

export const workFolderTask = {
  ...storybookIssues[0]!,
  title: "Prepare the launch report",
  description:
    "Review the launch brief and collect findings in the task folder. Keep the final report and supporting files available for the next run.",
  status: "in_review",
  checkoutRunId: null,
  executionRunId: null,
  executionWorkspaceId: null,
  currentExecutionWorkspace: null,
  responsibleUserId: "user-board",
  ancestors: [],
  children: [],
};
export const workFolderProject = storybookProjects[0]!;
export const workFolderAgent = {
  ...storybookAgents[0]!,
  chainOfCommand: [],
  access: {
    canAssignTasks: true,
    taskAssignSource: "explicit_grant",
    membership: null,
    grants: [],
  },
};

function seed(client: QueryClient, enableCachedTaskFiles: boolean) {
  const company = WORK_FOLDER_COMPANY;
  client.setQueryData(queryKeys.auth.session, storybookAuthSession);
  client.setQueryData(queryKeys.liveRuns(company), []);
  client.setQueryData(queryKeys.inboxAgentPolicy.mine(company), {
    companyId: company,
    userId: "user-board",
    mode: "open",
    allowedAgentIds: [],
    materialized: true,
    createdAt: null,
    updatedAt: null,
  });
  client.setQueryData(
    queryKeys.companies.list(storybookAuthSession.user.id),
    storybookCompanies,
  );
  client.setQueryData(queryKeys.agents.list(company), storybookAgents);
  client.setQueryData(queryKeys.projects.list(company), storybookProjects);
  client.setQueryData(queryKeys.issues.list(company), [workFolderTask]);
  for (const ref of [workFolderTask.id, workFolderTask.identifier!]) {
    client.setQueryData(queryKeys.issues.detail(ref), workFolderTask);
    client.setQueryData(queryKeys.issues.comments(ref), {
      pages: [[]],
      pageParams: [null],
    });
    for (const name of [
      "activity",
      "runs",
      "approvals",
      "attachments",
      "workProducts",
      "liveRuns",
      "interactions",
      "queuedComments",
    ] as const)
      client.setQueryData(queryKeys.issues[name](ref), []);
    client.setQueryData(queryKeys.issues.activeRun(ref), null);
  }
  for (const ref of [workFolderProject.id, workFolderProject.urlKey!])
    client.setQueryData(
      [...queryKeys.projects.detail(ref), company],
      workFolderProject,
    );
  for (const ref of [workFolderAgent.id, workFolderAgent.urlKey!])
    client.setQueryData(
      [...queryKeys.agents.detail(ref), company],
      workFolderAgent,
    );
  client.setQueryData(queryKeys.agents.runtimeState(workFolderAgent.id), null);
  client.setQueryData(queryKeys.heartbeats(company, workFolderAgent.id), []);
  client.setQueryData(
    [
      ...queryKeys.issues.list(company),
      "participant-agent",
      workFolderAgent.id,
    ],
    [workFolderTask],
  );
  client.setQueryData(
    queryKeys.issues.listByProject(company, workFolderProject.id),
    [workFolderTask],
  );
  client.setQueryData(queryKeys.budgets.overview(company), {
    companyId: company,
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  });
  client.setQueryData(queryKeys.resourceMemberships.mine(company), {
    projectMemberships: {},
    agentMemberships: {},
    starredProjects: [],
    starredAgents: [],
  });
  client.setQueryData(queryKeys.access.currentBoardAccess, {
    isInstanceAdmin: true,
    canCreateCompanies: true,
  });
  client.setQueryData(queryKeys.builtInAgents.list(company), []);
  client.setQueryData(queryKeys.instance.generalSettings, {
    keyboardShortcutsEnabled: false,
  });
  client.setQueryData(queryKeys.instance.experimentalSettings, {
    ...instanceExperimentalSettingsSchema.parse({}),
    enableCachedTaskFiles,
    enableIsolatedWorkspaces: true,
    enableManagedSandboxOnly: true,
  });
  client.setQueryData(queryKeys.health, {
    status: "ok",
    deploymentMode: "authenticated",
    authReady: true,
    companyCreationPolicy: "restricted",
  });
}

/** Mounted only for work-folder stories; resets cache, mutations, and fetch handlers on exit. */
export function WorkFolderStoryProvider({
  scenario = "saved",
  enableCachedTaskFiles = false,
  children,
}: {
  scenario?: WorkFolderScenario;
  enableCachedTaskFiles?: boolean;
  children: ReactNode;
}) {
  const [client] = useState(() => {
    const value = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    seed(value, enableCachedTaskFiles);
    return value;
  });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const fixture = createWorkFolderFixture(scenario);
    const originalFetch = window.fetch;
    const controller = new AbortController();
    const wrapped: typeof window.fetch = async (input, init) => {
      const request = new Request(
        input instanceof Request
          ? input
          : new URL(String(input), window.location.origin),
        { ...init, signal: controller.signal },
      );
      const response = await fixture.handle(request);
      if (response) return response;
      const url = new URL(request.url);
      if (url.pathname === "/api/instance/settings/experimental" && ["GET", "PATCH"].includes(request.method)) {
        const previous = client.getQueryData(queryKeys.instance.experimentalSettings) ?? {};
        const settings = request.method === "PATCH" ? { ...previous, ...await request.json() } : previous;
        client.setQueryData(queryKeys.instance.experimentalSettings, settings);
        return Response.json(settings);
      }
      if (url.pathname.startsWith("/api/") && request.method !== "GET") {
        // Incidental page read markers are harmless. Other page mutations are outside this demo.
        if (url.pathname.endsWith("/read"))
          return Response.json({
            id: workFolderTask.id,
            lastReadAt: new Date().toISOString(),
          });
        return Response.json(
          { error: "This Storybook only simulates work-folder actions." },
          { status: 422 },
        );
      }
      if (/^\/api\/issues\/[^/]+\/(watchdog|active-run)$/.test(url.pathname))
        return Response.json(null);
      if (
        /^\/api\/issues\/[^/]+\/(comments|activity|runs|approvals|attachments|work-products|live-runs|interactions|queued-comments|feedback-votes)$/.test(
          url.pathname,
        )
      )
        return Response.json([]);
      return originalFetch(input, init);
    };
    window.fetch = wrapped;
    // Anchor downloads are native navigations, so supply the same in-memory content as previews.
    const download = async (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.(
        "a[download]",
      ) as HTMLAnchorElement | null;
      if (!anchor || !anchor.pathname.includes("/work-folders/")) return;
      event.preventDefault();
      const response = await fixture.handle(new Request(anchor.href));
      if (!response?.ok) return;
      const href = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = href;
      link.download =
        new URL(anchor.href).searchParams.get("path")?.split("/").at(-1) ??
        "file";
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    };
    document.addEventListener("click", download);
    setReady(true);
    return () => {
      controller.abort();
      if (window.fetch === wrapped) window.fetch = originalFetch;
      document.removeEventListener("click", download);
      client.clear();
    };
  }, [client, scenario]);
  return (
    <QueryClientProvider client={client}>
      {ready ? children : null}
    </QueryClientProvider>
  );
}
