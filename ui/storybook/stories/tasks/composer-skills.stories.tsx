import { useLayoutEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { buildSkillMentionHref } from "@paperclipai/shared";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { TaskChatThreadView } from "@/components/task-chat/TaskChatThreadView";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { composerSkills } from "../../support/composerSkills";

function TaskSkillsStory() {
  const client = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const [sent, setSent] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (!selectedCompanyId) return;
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      if (url.pathname === `/api/companies/${selectedCompanyId}/skills`) return Response.json(composerSkills);
      if (url.pathname === `/api/companies/${selectedCompanyId}/routines`) return Response.json([]);
      return originalFetch(input, init);
    };
    client.setQueryData(queryKeys.companySkills.list(selectedCompanyId), composerSkills);
    client.setQueryData(queryKeys.routines.list(selectedCompanyId), []);
    return () => { window.fetch = originalFetch; };
  }, [client, selectedCompanyId]);

  return <div className="flex min-h-dvh flex-col bg-background text-foreground">
    <header className="flex h-12 items-center border-b border-border px-6 text-sm">Tasks / Fix the sign-in redirect</header>
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col p-6">
      <h1 className="mb-6 text-xl font-semibold">Fix the sign-in redirect</h1>
      <div className="flex flex-1 flex-col" data-task-chat-shell="">
        <TaskChatThreadView items={[
          { id: "request", kind: "message", author: "human", text: "Review the sign-in flow and fix the redirect after a session expires." },
          { id: "response", kind: "message", author: "agent", authorName: "Codex", text: "The redirect is fixed. Use a skill to check the full sign-in flow." },
        ]} />
        {sent && <output aria-label="Submitted Markdown" className="mb-4 text-sm">{sent}</output>}
        <TaskChatComposerDock mobile={false} streamlined={false}>
          <TaskChatComposer workMode="standard" onAdd={async (body) => { setSent(body); }} />
        </TaskChatComposerDock>
      </div>
    </main>
  </div>;
}

const meta = {
  id: "composer-skills",
  title: "Tasks and conversations/Task creation and lifecycle/Composer/Skills",
  component: TaskSkillsStory,
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["tasks/discussion", "tasks/create"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production task thread, dock, composer, and shared editor. Covers skill descriptions, absent descriptions, keyboard insertion, inline color/icon styling, and Markdown submission on desktop and mobile. Skills and submission use fixtures; no task persistence or agent execution is exercised. New-task equivalents are in new-task-composer.stories.tsx.",
    },
  },
} satisfies Meta<typeof TaskSkillsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SlashCommands: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.type(await page.findByRole("textbox", { name: "editable markdown" }), "/", { delay: 25 });
    const menu = within(await page.findByTestId("mention-autocomplete-menu"));
    await expect(menu.getByText("/test-it-for-real")).toBeVisible();
    await expect(menu.getByText(composerSkills[0]!.description!)).toBeVisible();
    await expect(menu.getByText("/release-notes")).toBeVisible();
  },
};

export const InlineSkill: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const editor = await page.findByRole("textbox", { name: "editable markdown" });
    await userEvent.type(editor, "Use /test-it", { delay: 25 });
    await expect(await page.findByTestId("mention-autocomplete-menu")).toBeVisible();
    await userEvent.keyboard("{Tab}");
    await waitFor(() => expect(editor.querySelector('[data-mention-kind="skill"]')).toBeVisible());
    await userEvent.keyboard(" to verify the sign-in redirect.", { delay: 25 });
    await expect(editor).toHaveTextContent("Use /test-it-for-real to verify the sign-in redirect.");
  },
};

export const SendInlineSkill: Story = {
  play: async (context) => {
    await InlineSkill.play!(context);
    const page = within(context.canvasElement.ownerDocument.body);
    await userEvent.keyboard("{Enter}");
    await expect(await page.findByRole("status", { name: "Submitted Markdown" })).toHaveTextContent(
      `Use [/test-it-for-real](${buildSkillMentionHref(composerSkills[0]!.id, composerSkills[0]!.slug)}) to verify the sign-in redirect.`,
    );
  },
};

export const MobileSlashCommands: Story = { ...SlashCommands, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileInlineSkill: Story = { ...InlineSkill, globals: { viewport: { value: "mobile", isRotated: false } } };
