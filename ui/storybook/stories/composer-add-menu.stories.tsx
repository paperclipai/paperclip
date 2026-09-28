import { useState, type CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ChevronLeft, Ellipsis } from "lucide-react";
import type { IssueAttachment, IssueWorkMode, RunnerGoalCapability } from "@paperclipai/shared";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TaskChatComposer } from "@/components/task-chat/TaskChatComposer";
import { TaskChatComposerDock } from "@/components/task-chat/TaskChatComposerDock";
import { composerAgentAppearance, composerAgents } from "../prototypes/composer-model-picker/fixtures";

const agentMap = new Map(composerAgents.map((agent) => [agent.id, {
  id: agent.id,
  name: agent.name,
  appearance: composerAgentAppearance(agent.id),
}]));
const assignees = composerAgents.map((agent) => ({
  id: `agent:${agent.id}`,
  label: agent.name,
  searchText: `${agent.name} ${agent.role} ${agent.harness}`,
}));

const goalCapability: RunnerGoalCapability = {
  availability: "available",
  verified: true,
  actions: ["set", "pause", "resume", "clear"],
  autonomousUpdates: true,
  persistentAcrossResume: true,
  maxObjectiveChars: 4_000,
  tokenBudgetControl: true,
  usageReporting: true,
};

interface ComposerAddStoryProps {
  initialMode: IssueWorkMode;
  goalAvailable: boolean;
  mobile: boolean;
  mobileContext: boolean;
  fullBleedMobileContext: boolean;
}

function ComposerAddStory({ initialMode, goalAvailable, mobile, mobileContext, fullBleedMobileContext }: ComposerAddStoryProps) {
  const [workMode, setWorkMode] = useState(initialMode);
  const [sent, setSent] = useState<string[]>([]);
  const [goal, setGoal] = useState<string | null>(null);

  async function attachFile(file: File): Promise<IssueAttachment> {
    return {
      id: crypto.randomUUID(), companyId: "storybook", issueId: "composer-story",
      issueCommentId: null, assetId: crypto.randomUUID(), provider: "storybook",
      objectKey: file.name, contentType: file.type, byteSize: file.size, sha256: "storybook",
      originalFilename: file.name, createdByAgentId: null, createdByUserId: "storybook",
      createdAt: new Date(), updatedAt: new Date(), contentPath: URL.createObjectURL(file),
    };
  }

  const composer = <TaskChatComposer
    onAdd={async (body) => setSent((messages) => [...messages, body])}
    workMode={workMode}
    onWorkModeChange={setWorkMode}
    onAttachImage={attachFile}
    enableReassign
    reassignOptions={assignees}
    agentMap={agentMap}
    currentAssigneeValue="agent:codex"
    runnerGoalCapability={goalAvailable ? goalCapability : { ...goalCapability, availability: "unsupported", actions: [] }}
    onRunnerGoalCommand={goalAvailable ? async (command) => {
      if (command.action === "create") setGoal(command.objective);
    } : undefined}
    mobile={mobile}
  />;

  if (mobileContext) return <div className="flex min-h-dvh flex-col bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center gap-3 px-4 text-sm">
      <ChevronLeft className="size-4 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-medium">PAP-1074 · Composer on mobile</span>
      <Ellipsis className="size-4 text-muted-foreground" aria-hidden />
    </header>
    <main className="flex flex-1 flex-col p-4 pb-(--tc-composer-visible-nav-offset)"
      style={{ "--tc-composer-bottom": "var(--tc-composer-visible-nav-offset)" } as CSSProperties}>
      {/* Production's full-width chat tab cancels the page's p-4 with -mx-4. */}
      <div className={fullBleedMobileContext ? "-mx-4 flex flex-1 flex-col" : "flex flex-1 flex-col"}>
        <div className={fullBleedMobileContext ? "space-y-4 px-4 text-sm" : "space-y-4 text-sm"}>
          <div className="rounded-lg bg-muted px-3 py-2">Tune the composer spacing for a phone screen.</div>
          <div className="ml-8 rounded-lg bg-secondary px-3 py-2">The bottom navigation stays visible while writing.</div>
          {goal ? <div className="rounded-lg bg-card px-3 py-2">Goal: {goal}</div> : null}
          {sent.map((body, index) => <div key={index} className="ml-8 rounded-lg bg-secondary px-3 py-2">{body}</div>)}
        </div>
        <div className="min-h-4 flex-1" />
        <TaskChatComposerDock mobile streamlined={!fullBleedMobileContext}>{composer}</TaskChatComposerDock>
      </div>
    </main>
    <MobileBottomNav visible />
  </div>;

  return <div className="flex min-h-screen flex-col bg-background p-4 text-foreground sm:p-8">
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
      <header className="border-b border-border pb-4">
        <h1 className="text-base font-semibold">Composer actions</h1>
        <p className="mt-1 text-sm text-muted-foreground">Open the plus menu to attach a file, start a goal, or choose Plan or Ask mode.</p>
      </header>
      <div className="flex flex-1 flex-col justify-end gap-3 py-6">
        {goal ? <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm">Goal: {goal}</div> : null}
        {sent.map((body, index) => <div key={index} className="ml-auto rounded-lg bg-secondary px-4 py-3 text-sm">{body}</div>)}
      </div>
      {composer}
    </div>
  </div>;
}

const meta = {
  title: "Composer/Add menu",
  component: ComposerAddStory,
  parameters: {
    layout: "fullscreen",
    options: { showPanel: false },
    docs: { description: { component: "The production task composer. The Add menu opens upward on desktop and as a dialog on mobile for files, supported goals, Plan mode, and Ask mode. Plan and Ask are exclusive; selecting a mode shows a removable chip. Cmd+. cycles standard, Plan, and Ask. Mobile stories include capsule agent avatars and the actual bottom navigation." } },
  },
  args: { initialMode: "standard", goalAvailable: true, mobile: false, mobileContext: false, fullBleedMobileContext: false },
} satisfies Meta<typeof ComposerAddStory>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openAdd(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole("button", { name: "Add to composer" }));
  return page;
}

export const AddMenu: Story = {
  name: "01 · Plus menu with goal",
  play: async ({ canvasElement }) => {
    const page = await openAdd(canvasElement);
    await expect(page.getByRole("menuitem", { name: /Files and images/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Goal/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Plan mode/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Ask mode/ })).toBeVisible();
  },
};

export const PlanChip: Story = {
  name: "02 · Plan mode chip",
  args: { initialMode: "planning" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = page.getByRole("button", { name: "Remove Plan mode" });
    const assignee = page.getByTestId("task-chat-composer-assignee");
    await expect(chip).toBeVisible();
    await expect(chip.getBoundingClientRect().height).toBe(assignee.getBoundingClientRect().height);
    await expect(Math.abs(chip.getBoundingClientRect().top - assignee.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
  },
};

export const AskChip: Story = {
  name: "03 · Ask mode chip",
  args: { initialMode: "ask" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = page.getByRole("button", { name: "Remove Ask mode" });
    const assignee = page.getByTestId("task-chat-composer-assignee");
    await expect(chip).toBeVisible();
    await expect(chip.getBoundingClientRect().height).toBe(assignee.getBoundingClientRect().height);
    await expect(Math.abs(chip.getBoundingClientRect().top - assignee.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
  },
};

export const SwitchModes: Story = {
  name: "04 · Choose and remove a mode",
  play: async ({ canvasElement }) => {
    const page = await openAdd(canvasElement);
    await userEvent.click(page.getByRole("menuitem", { name: /Plan mode/ }));
    await expect(page.getByRole("button", { name: "Remove Plan mode" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Add to composer" }));
    await userEvent.click(page.getByRole("menuitem", { name: /Ask mode/ }));
    await expect(page.queryByRole("button", { name: "Remove Plan mode" })).not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Remove Ask mode" }));
    await expect(page.queryByRole("button", { name: /Remove .* mode/ })).not.toBeInTheDocument();
  },
};

export const FileUpload: Story = {
  name: "05 · Attached file",
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, new File(["Storybook attachment"], "launch-plan.txt", { type: "text/plain" }));
    await expect(page.getByText("launch-plan.txt")).toBeVisible();
  },
};

export const GoalUnavailable: Story = {
  name: "06 · Agent without goals",
  args: { goalAvailable: false },
  play: async ({ canvasElement }) => {
    const page = await openAdd(canvasElement);
    await expect(page.queryByRole("menuitem", { name: /Goal/ })).not.toBeInTheDocument();
  },
};

export const Mobile: Story = {
  name: "07 · Mobile Add dialog",
  args: { mobile: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = await openAdd(canvasElement);
    await expect(page.getByRole("dialog", { name: "Add" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Plan mode/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Files and images/ })).toBeVisible();
  },
};

export const GoalDraft: Story = {
  name: "08 · Start a supported goal",
  play: async ({ canvasElement }) => {
    const page = await openAdd(canvasElement);
    await userEvent.click(page.getByRole("menuitem", { name: /Goal/ }));
    await expect(page.getByRole("textbox", { name: "editable markdown" })).toHaveTextContent("/goal");
  },
};

export const MobileWithBottomBar: Story = {
  name: "09 · Mobile with bottom bar",
  args: { mobile: true, mobileContext: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-dock")).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-assignee").querySelector('[data-slot="agent-avatar"] img')).toBeVisible();
  },
};

export const MobilePlanWithBottomBar: Story = {
  name: "10 · Mobile plan and attachment with bottom bar",
  args: { initialMode: "planning", mobile: true, mobileContext: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const input = canvasElement.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, new File(["Mobile layout"], "notes.txt", { type: "text/plain" }));
    await expect(page.getByText("notes.txt")).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove Plan mode" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    const plus = page.getByRole("button", { name: "Add to composer" }).getBoundingClientRect();
    const send = page.getByRole("button", { name: "Send" }).getBoundingClientRect();
    const chip = page.getByRole("button", { name: "Remove Plan mode" }).getBoundingClientRect();
    await expect(send.width).toBe(send.height);
    await expect(Math.abs(plus.top - send.top)).toBeLessThanOrEqual(1);
    await expect(Math.abs(chip.top - send.top)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Remove Plan mode" }).querySelector(".sr-only")?.textContent).toBe("Plan mode");
  },
};

export const MobileAskWithBottomBar: Story = {
  name: "10b · Mobile Ask with bottom bar",
  args: { initialMode: "ask", mobile: true, mobileContext: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const chip = page.getByRole("button", { name: "Remove Ask mode" }).getBoundingClientRect();
    const send = page.getByRole("button", { name: "Send" }).getBoundingClientRect();
    await expect(send.width).toBe(send.height);
    await expect(Math.abs(chip.top - send.top)).toBeLessThanOrEqual(1);
    await expect(page.getByRole("button", { name: "Remove Ask mode" }).querySelector(".sr-only")?.textContent).toBe("Ask mode");
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
  },
};

export const MobileFullBleedChatWithBottomBar: Story = {
  name: "11 · Mobile full-width chat with bottom bar",
  args: { mobile: true, mobileContext: true, fullBleedMobileContext: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-dock")).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-assignee").querySelector('[data-slot="agent-avatar"] img')).toBeVisible();
  },
};

export const MobileAddDialogWithBottomBar: Story = {
  name: "12 · Mobile Add dialog with bottom bar",
  args: { mobile: true, mobileContext: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await openAdd(canvasElement);
    await expect(page.getByRole("dialog", { name: "Add" })).toBeVisible();
  },
};

export const MobileGoalFromAddDialog: Story = {
  name: "13 · Mobile Goal keeps editor focus",
  args: { mobile: true, mobileContext: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
  play: async ({ canvasElement }) => {
    const page = await openAdd(canvasElement);
    await userEvent.click(page.getByRole("button", { name: /Goal Keep pursuing/ }));
    const editor = page.getByRole("textbox", { name: "editable markdown" });
    await expect(editor).toHaveTextContent("/goal");
    await waitFor(() => expect(editor).toHaveFocus());
  },
};
