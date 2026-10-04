import { useLayoutEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { useCompany } from "@/context/CompanyContext";
import { useDialog } from "@/context/DialogContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  storybookAgents,
  storybookAuthSession,
  storybookExecutionWorkspaces,
  storybookProjects,
} from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";
const REQUEST = "Review the sign-in flow and fix the redirect after a session expires.";

function NewTaskStory({
  scenario = "empty",
}: {
  scenario?: "empty" | "prefilled" | "title" | "subtask" | "planning" | "error" | "saving";
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
  }, [scenario]);

  useLayoutEffect(() => {
    if (selectedCompanyId !== COMPANY_ID) {
      setSelectedCompanyId(COMPANY_ID);
      return;
    }
    if (opened.current) return;
    opened.current = true;
    localStorage.removeItem("paperclip:issue-draft");
    client.setQueryData(queryKeys.auth.session, storybookAuthSession);
    client.setQueryData(
      queryKeys.agents.list(COMPANY_ID),
      storybookAgents.map((agent) =>
        agent.id === "agent-codex"
          ? {
              ...agent,
              adapterConfig: { ...agent.adapterConfig, model: "gpt-6-sol" },
            }
          : agent,
      ),
    );
    client.setQueryData(queryKeys.agents.adapterModels(COMPANY_ID, "codex_local"), [
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
    ]);
    client.setQueryData(queryKeys.projects.list(COMPANY_ID), storybookProjects);
    client.setQueryData(queryKeys.instance.experimentalSettings, {
      enableIsolatedWorkspaces: true,
    });
    client.setQueryData(
      queryKeys.executionWorkspaces.summaryList(COMPANY_ID, {
        projectId: "project-board-ui",
        projectWorkspaceId: "workspace-board-ui",
        reuseEligible: true,
      }),
      storybookExecutionWorkspaces,
    );
    openNewIssue(
      scenario === "empty"
        ? {}
        : {
            description: REQUEST,
            ...(scenario === "title" ? { title: "Fix the sign-in redirect" } : {}),
            assigneeAgentId: "agent-codex",
            projectId: "project-board-ui",
            projectWorkspaceId: "workspace-board-ui",
            workMode: scenario === "planning" ? "planning" : "standard",
            ...(scenario === "subtask"
              ? {
                  parentId: "issue-storybook-1",
                  parentIdentifier: "PAP-203",
                  parentTitle: "Improve sign-in reliability",
                  executionWorkspaceId: storybookExecutionWorkspaces[0]?.id,
                }
              : {}),
          },
    );
  }, [client, openNewIssue, scenario, selectedCompanyId, setSelectedCompanyId]);

  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      {submitted ? (
        <div role="status" className="mt-4 space-y-2">
          <p>Task created</p>
          <p>{String(submitted.description ?? submitted.title)}</p>
          <p>Mode: {String(submitted.workMode)}</p>
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
          "The production new-task dialog renders TaskChatComposer: the same editor, add menu, work modes, assignee/model/effort picker, and send button as an existing task. Project sits in the bottom toolbar immediately before the assignee. Creation is mocked locally; no agents run.",
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
  },
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
        name: "Select assignee, model and effort",
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
