import { useLayoutEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import {
  appearanceForPalette,
  buildAgentMentionHref,
  buildIssueReferenceHref,
  buildProjectMentionHref,
  buildRoutineMentionHref,
  buildSkillMentionHref,
  buildUserMentionHref,
} from "@paperclipai/shared";
import { MarkdownBody } from "@/components/MarkdownBody";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import { trackRecentAssignee, trackRecentAssigneeUser } from "@/lib/recent-assignees";
import { trackRecentProject } from "@/lib/recent-projects";
import { rememberComposerEffort } from "@/lib/recent-composer-effort";
import {
  storybookAgents,
  storybookAuthSession,
  storybookExecutionWorkspaces,
  storybookProjects,
  storybookIssues,
} from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const NEW_TASK_AGENTS = [...storybookAgents, { ...storybookAgents[2]!, id: "agent-ceo", name: "CEO", role: "ceo" }].map((agent) =>
  agent.id === "agent-codex"
    ? { ...agent, adapterConfig: { ...agent.adapterConfig, model: "gpt-6-sol" }, appearance: appearanceForPalette("electric-grove") }
    : { ...agent, appearance: appearanceForPalette("pink-lemonade") },
);
const REQUEST = "Review the sign-in flow and fix the redirect after a session expires.";
const SKILLS = [{ id: "skill-test-drive", key: "test-it-for-real", slug: "test-it-for-real", name: "Test it for real", description: "Walk through the feature in the browser." }];
const ROUTINES = [{ id: "routine-daily-check", title: "Daily check-in", status: "active" }];
const RICH_REQUEST = [
  `Ask [@CodexCoder](${buildAgentMentionHref("agent-codex", "code")}) and [@QAChecker](${buildAgentMentionHref("agent-qa", "shield")}) to review [@Board UI](${buildProjectMentionHref("project-board-ui", storybookProjects[0]!.color)}).`,
  `Check [PAP-1602](${buildIssueReferenceHref("PAP-1602")}) with [@Product Lead](${buildUserMentionHref("user-product")}) using [/test-it-for-real](${buildSkillMentionHref(SKILLS[0]!.id, SKILLS[0]!.slug)}).`,
  `Use [/routine:Daily check-in](${buildRoutineMentionHref(ROUTINES[0]!.id)}) as the checklist.`,
].join("\n\n");
const WORKTREES = [
  { ...storybookExecutionWorkspaces[0]!, name: "Sign-in redirect", branchName: "codex/sign-in-redirect" },
  { ...storybookExecutionWorkspaces[0]!, id: "worktree-settings", name: "Settings polish", branchName: "codex/settings-polish", projectWorkspaceId: "workspace-release-local", cwd: `${storybookExecutionWorkspaces[0]!.cwd}-settings` },
];

function NewTaskStory({
  scenario = "empty",
  worktrees = "ready",
  isolation = true,
  rememberedAssignee = "none",
  rememberedProject = false,
  rememberedEffort = false,
}: {
  scenario?: "empty" | "prefilled" | "title" | "subtask" | "planning" | "error" | "saving" | "rich";
  worktrees?: "ready" | "reuse" | "empty" | "loading" | "error";
  isolation?: boolean;
  rememberedAssignee?: "none" | "agent" | "human";
  rememberedProject?: boolean;
  rememberedEffort?: boolean;
}) {
  const client = useQueryClient();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const opened = useRef(false);
  const [submitted, setSubmitted] = useState<Record<string, unknown> | null>(null);

  useLayoutEffect(() => {
    const originalFetch = window.fetch;
    const imageUrls: string[] = [];
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        location.origin,
      );
      if (url.pathname === `/api/companies/${COMPANY_ID}/skills`) return Response.json(SKILLS);
      if (url.pathname === `/api/companies/${COMPANY_ID}/agents`) return Response.json(NEW_TASK_AGENTS);
      if (url.pathname === `/api/companies/${COMPANY_ID}/routines`) return Response.json(ROUTINES);
      if (url.pathname === `/api/companies/${COMPANY_ID}/execution-workspaces`) {
        if (worktrees === "loading") return new Promise<Response>(() => {});
        if (worktrees === "error") return Response.json({ error: "Worktrees unavailable" }, { status: 503 });
        return Response.json(worktrees === "empty" || url.searchParams.get("projectId") !== "project-board-ui" ? [] : WORKTREES);
      }
      if (url.pathname === `/api/companies/${COMPANY_ID}/assets/images` && init?.method === "POST") {
        const file = init.body instanceof FormData ? init.body.get("file") : null;
        if (!(file instanceof File)) return Response.json({ error: "Select an image" }, { status: 400 });
        const contentPath = URL.createObjectURL(file);
        imageUrls.push(contentPath);
        return Response.json({ contentPath });
      }
      if (url.pathname === `/api/companies/${COMPANY_ID}/issues` && init?.method === "POST") {
        if (scenario === "saving") return new Promise<Response>(() => {});
        if (scenario === "error")
          return Response.json(
            {
              error: "Could not create the task. Your draft is saved; try again.",
            },
            { status: 503 },
          );
        const data = JSON.parse(String(init.body)) as Record<string, unknown>;
        setSubmitted(data);
        return Response.json({
          ...data,
          id: "storybook-created-task",
          identifier: "PAP-204",
          companyId: COMPANY_ID,
        });
      }
      return originalFetch(input, init);
    };
    return () => {
      window.fetch = originalFetch;
      imageUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [scenario, worktrees]);

  useLayoutEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) {
      setSelectedCompanyId(COMPANY_ID);
      return;
    }
    if (opened.current) return;
    opened.current = true;
    localStorage.removeItem("paperclip:issue-draft");
    localStorage.removeItem("paperclip:recent-assignees");
    localStorage.removeItem(`paperclip:recent-assignees:${COMPANY_ID}`);
    localStorage.removeItem("paperclip:recent-projects");
    localStorage.removeItem(`paperclip:recent-projects:${COMPANY_ID}`);
    localStorage.removeItem(`paperclip:composer-effort:${COMPANY_ID}`);
    if (rememberedAssignee === "agent") trackRecentAssignee("agent-codex", COMPANY_ID);
    if (rememberedAssignee === "human") trackRecentAssigneeUser(storybookAuthSession.user.id, COMPANY_ID);
    if (rememberedProject) trackRecentProject("project-board-ui", COMPANY_ID);
    if (rememberedEffort) rememberComposerEffort(COMPANY_ID, "high");
    client.setQueryData(queryKeys.health, { hiddenSettings: [] });
    client.setQueryData(queryKeys.auth.session, storybookAuthSession);
    client.setQueryData(
      queryKeys.agents.list(COMPANY_ID),
      NEW_TASK_AGENTS,
    );
    client.setQueryData(queryKeys.agents.adapterModels(COMPANY_ID, "codex_local"), [
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
    ]);
    client.setQueryData(queryKeys.projects.list(COMPANY_ID), isolation ? storybookProjects : storybookProjects.map((project) => ({
      ...project, executionWorkspacePolicy: { ...project.executionWorkspacePolicy, enabled: false },
    })));
    client.setQueryData(queryKeys.issues.mentionPool(COMPANY_ID), storybookIssues);
    client.setQueryData(queryKeys.companySkills.list(COMPANY_ID), SKILLS);
    client.setQueryData(queryKeys.routines.list(COMPANY_ID), ROUTINES);
    client.setQueryData(queryKeys.instance.experimentalSettings, {
      enableIsolatedWorkspaces: true,
    });
    const worktreeQueryKey = queryKeys.executionWorkspaces.summaryList(COMPANY_ID, {
      projectId: "project-board-ui",
      reuseEligible: true,
    });
    client.removeQueries({ queryKey: worktreeQueryKey, exact: true });
    if (worktrees !== "loading" && worktrees !== "error") client.setQueryData(
      worktreeQueryKey,
      worktrees === "empty" ? [] : WORKTREES,
    );
    openNewIssue(
      scenario === "empty"
        ? {}
        : {
            description: scenario === "rich" ? RICH_REQUEST : REQUEST,
            ...(scenario === "title" ? { title: "Fix the sign-in redirect" } : {}),
            assigneeAgentId: "agent-codex",
            projectId: "project-board-ui",
            projectWorkspaceId: "workspace-board-ui",
            workMode: scenario === "planning" ? "planning" : "standard",
            ...(worktrees === "reuse" ? { executionWorkspaceId: WORKTREES[0]!.id } : {}),
            ...(scenario === "subtask"
              ? {
                  parentId: "issue-storybook-1",
                  parentIdentifier: "PAP-203",
                  parentTitle: "Improve sign-in reliability",
                  executionWorkspaceId: WORKTREES[0]!.id,
                  parentExecutionWorkspaceLabel: WORKTREES[0]!.name,
                }
              : {}),
          },
    );
  }, [client, isolation, openNewIssue, rememberedAssignee, rememberedProject, rememberedEffort, scenario, selectedCompanyId, setSelectedCompanyId, worktrees]);

  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      {submitted ? (
        <div role="status" className="mt-4 space-y-2">
          <p>Task created</p>
          <MarkdownBody>{String(submitted.description ?? submitted.title)}</MarkdownBody>
          <p>Mode: {String(submitted.workMode)}</p>
          <p>Worktrees: {String(submitted.executionWorkspacePreference ?? "Project default")}</p>
          <p>Checkout: {String(submitted.projectWorkspaceId ?? "None")}</p>
          {submitted.executionWorkspaceId ? <p>Reused: {String(submitted.executionWorkspaceId)}</p> : null}
        </div>
      ) : null}
      <NewIssueDialog />
    </div>
  );
}

const meta = {
  title: "Composer/New task",
  component: NewTaskStory,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    options: { showPanel: false },
    waitForViewport: true,
    docs: {
      description: {
        component:
          "The production new-task dialog renders TaskChatComposer. An inset bar shared with queued messages holds the colored project picker and, for projects with isolation enabled, Worktrees. Choose a new worktree or reuse a project worktree. The shared editor supports agent, person, project, and task mentions plus skill and routine slash-command chips. Agent mentions show the agent's current avatar. The editor, add menu, work modes, assignee/model/effort picker, and send button are shared with task chat. Creation is mocked locally; no agents run.",
      },
    },
  },
  args: { scenario: "empty" },
} satisfies Meta<typeof NewTaskStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole("button", { name: "Create task" })).toBeDisabled();
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    await waitFor(() => expect(page.getByTestId("task-chat-composer-assignee-label")).toHaveTextContent("CEO"));
    await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveTextContent("");
    await expect(page.getByRole("textbox", { name: "editable markdown" }).querySelector('[data-mention-kind]')).toBeNull();
  },
};
export const LastAssignee: Story = {
  args: { rememberedAssignee: "agent" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByTestId("task-chat-composer-assignee-label")).toHaveTextContent("CodexCoder"));
    await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveTextContent("");
  },
};
export const ReturningPreferences: Story = {
  args: { rememberedAssignee: "agent", rememberedProject: true, rememberedEffort: true },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByTestId("task-chat-composer-assignee-label")).toHaveTextContent("CodexCoder"));
    await expect(page.getByTestId("task-chat-composer-context")).toHaveTextContent("Board UI");
    await userEvent.click(page.getByRole("button", { name: "Select model and effort" }));
    await waitFor(() => expect(page.getByTestId("selected-effort")).toHaveTextContent("High"));
  },
};
export const MobileReturningPreferences: Story = {
  ...ReturningPreferences,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const HumanAssignee: Story = {
  args: { rememberedAssignee: "human" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(page.getByTestId("task-chat-composer-assignee-label")).toHaveTextContent("Me"));
    await expect(page.queryByRole("button", { name: "Select model and effort" })).not.toBeInTheDocument();
    await expect(page.queryByTestId("task-chat-composer-model-label")).not.toBeInTheDocument();
  },
};
export const AssigneePicker: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Select assignee" }));
    await expect(page.getByRole("searchbox", { name: "Search assignees" })).toBeVisible();
    await expect(page.getByRole("listbox", { name: "Assignees" })).toBeVisible();
  },
};
export const NoAssignee: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Select assignee" }));
    await userEvent.click(page.getByRole("option", { name: "No assignee" }));
    await expect(page.queryByRole("listbox", { name: "Assignees" })).not.toBeInTheDocument();
    await expect(page.getByTestId("task-chat-composer-assignee-label")).toHaveTextContent("No assignee");
    await expect(page.queryByTestId("task-chat-composer-model-label")).not.toBeInTheDocument();
  },
};
export const MobileAssigneePicker: Story = {
  ...AssigneePicker,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const Prefilled: Story = { args: { scenario: "prefilled" } };
export const InheritedTitle: Story = { args: { scenario: "title" } };
export const Planning: Story = { args: { scenario: "planning" } };
export const SubTask: Story = { args: { scenario: "subtask" } };
export const ProjectPicker: Story = {
  args: { scenario: "prefilled" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Board UI" }));
    await expect(page.getByPlaceholderText("Search projects...")).toBeVisible();
  },
};
export const ModelPicker: Story = {
  args: { scenario: "prefilled" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", {
        name: "Select model and effort",
      }),
    );
    await expect(page.getByRole("button", { name: "Choose exact model" })).toBeVisible();
  },
};
export const Files: Story = {
  args: { scenario: "prefilled" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await page.findByTestId("task-chat-composer-input");
    const input = canvasElement.ownerDocument.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      new File(["# Sign-in plan\n\nReproduce the redirect."], "plan.md", {
        type: "text/markdown",
      }),
      new File(["fixture"], "redirect.png", { type: "image/png" }),
    ]);
    await expect(page.getByText("plan.md")).toBeVisible();
    await expect(page.getByText("redirect.png")).toBeVisible();
  },
};
export const Saving: Story = {
  args: { scenario: "saving" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const send = await page.findByRole("button", { name: "Create task" });
    await userEvent.click(send);
    await expect(send).toHaveAttribute("aria-busy", "true");
    await expect(page.getByTestId("task-chat-composer-input")).toHaveTextContent(REQUEST);
  },
};
export const SaveError: Story = {
  args: { scenario: "error" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Create task" }));
    await expect(await page.findByRole("alert")).toHaveTextContent("Your draft is saved");
    await expect(page.getByTestId("task-chat-composer-input")).toHaveTextContent(REQUEST);
  },
};
export const CreateFromComposer: Story = {
  args: { scenario: "planning" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Create task" }));
    await expect(await page.findByRole("status")).toHaveTextContent("Task created");
    await expect(page.getByRole("status")).toHaveTextContent("Mode: planning");
  },
};
export const Light: Story = {
  args: { scenario: "prefilled" },
  globals: { theme: "light" },
};
export const Mobile: Story = {
  args: { scenario: "prefilled" },
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const MobileProjectPicker: Story = {
  ...ProjectPicker,
  globals: { viewport: { value: "mobile", isRotated: false } },
};
export const MobileModelPicker: Story = {
  ...ModelPicker,
  globals: { viewport: { value: "mobile", isRotated: false } },
};

export const WorktreePicker: Story = {
  args: { scenario: "prefilled" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("combobox", { name: "Worktrees" }));
    await expect(page.getByPlaceholderText("Search worktrees...")).toBeVisible();
    await expect(page.getByRole("option", { name: /New worktree/ })).toBeVisible();
    await expect(page.getByRole("option", { name: /Sign-in redirect/ })).toBeVisible();
  },
};
export const ReuseWorktree: Story = {
  args: { scenario: "prefilled", worktrees: "reuse" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByRole("combobox", { name: "Worktrees" })).toHaveTextContent("Sign-in redirect");
  },
};
export const CreateWithReusedWorktree: Story = {
  args: { scenario: "prefilled" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("combobox", { name: "Worktrees" }));
    await userEvent.type(page.getByPlaceholderText("Search worktrees..."), "settings");
    await userEvent.click(await page.findByRole("option", { name: /Settings polish/ }));
    await expect(page.getByRole("combobox", { name: "Worktrees" })).toHaveTextContent("Settings polish");
    await userEvent.click(page.getByRole("button", { name: "Create task" }));
    await expect(await page.findByRole("status")).toHaveTextContent("Worktrees: reuse_existing");
    await expect(page.getByRole("status")).toHaveTextContent("Reused: worktree-settings");
    await expect(page.getByRole("status")).toHaveTextContent("Checkout: workspace-release-local");
  },
};
export const NewWorktreeAfterReuse: Story = {
  args: { scenario: "prefilled" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("combobox", { name: "Worktrees" }));
    await userEvent.click(await page.findByRole("option", { name: /Settings polish/ }));
    await userEvent.click(page.getByRole("combobox", { name: "Worktrees" }));
    await userEvent.click(page.getByRole("option", { name: /New worktree/ }));
    await userEvent.click(page.getByRole("button", { name: "Create task" }));
    await expect(await page.findByRole("status")).toHaveTextContent("Worktrees: isolated_workspace");
    await expect(page.getByRole("status")).toHaveTextContent("Checkout: workspace-board-ui");
    await expect(page.getByRole("status")).not.toHaveTextContent("Reused:");
  },
};
export const EmptyWorktrees: Story = { ...WorktreePicker, args: { scenario: "prefilled", worktrees: "empty" }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("combobox", { name: "Worktrees" }));
  await expect(page.getByText(/No existing worktrees yet/)).toBeVisible();
  await expect(page.getByRole("option", { name: /New worktree/ })).toBeVisible();
} };
export const LoadingWorktrees: Story = { ...EmptyWorktrees, args: { scenario: "prefilled", worktrees: "loading" }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("combobox", { name: "Worktrees" }));
  await expect(page.getByText("Loading existing worktrees…")).toBeVisible();
  await expect(page.getByRole("option", { name: /New worktree/ })).toBeVisible();
} };
export const WorktreeError: Story = { ...EmptyWorktrees, args: { scenario: "prefilled", worktrees: "error" }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("combobox", { name: "Worktrees" }));
  await expect(await page.findByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("option", { name: /New worktree/ })).toBeVisible();
} };
export const IsolationDisabled: Story = { args: { scenario: "prefilled", isolation: false }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await expect(await page.findByRole("button", { name: "Board UI" })).toBeVisible();
  await expect(page.queryByRole("combobox", { name: "Worktrees" })).not.toBeInTheDocument();
} };
export const MobileWorktreePicker: Story = {
  ...WorktreePicker,
  globals: { viewport: { value: "mobile", isRotated: false } },
};

export const MentionPicker: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const editor = await page.findByRole("textbox", { name: "editable markdown" });
    await userEvent.type(editor, "@");
    const menu = await page.findByTestId("mention-autocomplete-menu");
    await expect(within(menu).getByText("CodexCoder")).toBeVisible();
    await expect(menu.querySelector('[data-slot="agent-avatar"] img')).toBeVisible();
    await expect(within(menu).getByText("Product Lead")).toBeVisible();
    await expect(within(menu).getByText("Board UI")).toBeVisible();
    await expect(within(menu).getByText("PAP-1602")).toBeVisible();
    await expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(canvasElement.ownerDocument.defaultView!.innerWidth);
  },
};

export const SlashCommands: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(await page.findByRole("textbox", { name: "editable markdown" }), "/");
    const menuElement = await page.findByTestId("mention-autocomplete-menu");
    const menu = within(menuElement);
    await expect(menu.getByText("/test-it-for-real")).toBeVisible();
    await expect(menu.getByText("/routine:Daily check-in")).toBeVisible();
    await expect(menuElement.getBoundingClientRect().right).toBeLessThanOrEqual(canvasElement.ownerDocument.defaultView!.innerWidth);
  },
};

export const RichChips: Story = {
  args: { scenario: "rich" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const composer = await page.findByTestId("task-chat-composer-input");
    for (const kind of ["agent", "user", "project", "issue", "skill", "routine"]) {
      await waitFor(() => expect(composer.querySelector(`[data-mention-kind="${kind}"]`)).toBeVisible());
    }
    const agentChip = composer.querySelector('[data-mention-kind="agent"]')!;
    await expect(agentChip).toHaveAttribute("style", expect.stringContaining("--paperclip-mention-avatar-image"));
    await expect(canvasElement.ownerDocument.defaultView!.getComputedStyle(agentChip, "::before").backgroundImage)
      .toContain(new URL("./agent-avatar-images/", canvasElement.ownerDocument.baseURI).href);
  },
};

export const CreateWithRichChips: Story = {
  args: { scenario: "rich" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Create task" }));
    const receipt = await page.findByRole("status");
    await expect(receipt).toHaveTextContent("Task created");
    await expect(receipt).toHaveTextContent("/test-it-for-real");
    await expect(receipt).toHaveTextContent("/routine:Daily check-in");
    await expect(receipt.querySelector('[data-mention-kind="agent"]')).toHaveAttribute("style", expect.stringContaining("electric-grove"));
  },
};

export const InsertRichChips: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const editor = await page.findByRole("textbox", { name: "editable markdown" });
    await userEvent.click(editor);
    for (const [query, option] of [
      ["@Codex", /CodexCoder/],
      [" @Product", /Product Lead/],
      [" @Board UI", /Board UI/],
      [" @PAP-1602", /PAP-1602/],
      [" /test-it", /test-it-for-real/],
      [" /routine:Daily", /routine:Daily check-in/],
    ] as const) {
      await waitFor(() => expect(editor).toHaveFocus());
      await userEvent.keyboard(query);
      const menu = within(await page.findByTestId("mention-autocomplete-menu"));
      await userEvent.click(await menu.findByRole("button", { name: option }));
    }
    await waitFor(() => expect(editor).toHaveFocus());
    await userEvent.keyboard(" Please review these together.");
    await userEvent.click(page.getByRole("button", { name: "Create task" }));
    const receipt = await page.findByRole("status");
    await expect(receipt).toHaveTextContent("Please review these together.");
    for (const kind of ["agent", "user", "project", "skill", "routine"]) {
      await expect(receipt.querySelector(`[data-mention-kind="${kind}"]`)).toBeVisible();
    }
    await expect(within(receipt).getByRole("link", { name: "Issue PAP-1602" })).toBeVisible();
  },
};

export const MobileMentionPicker: Story = { ...MentionPicker, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileSlashCommands: Story = { ...SlashCommands, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileRichChips: Story = { ...RichChips, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileInsertRichChips: Story = { ...InsertRichChips, globals: { viewport: { value: "mobile", isRotated: false } } };
