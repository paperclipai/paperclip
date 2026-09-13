import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WorkFolderBrowser } from "@/components/WorkFolderBrowser";
import { WorkFolderStoryProvider } from "../fixtures/WorkFolderStoryProvider";
import {
  workFolderOwners,
  type WorkFolderScenario,
} from "../fixtures/workFolders";
import type { WorkFolderScope } from "@paperclipai/shared";

type Args = {
  scope: WorkFolderScope;
  scenario: WorkFolderScenario;
};
const meta = {
  title: "Work folders/Stored-file prototype",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Editable stored-file browser prototype using disposable in-memory data. The experimental task inspector reuses this browser with selection, trash, and restore controls. Saved copies are not the live sandbox filesystem.",
      },
    },
  },
  args: { scope: "task", scenario: "saved" },
  argTypes: {
    scope: { control: "select", options: ["task", "agent", "project", "user"] },
    scenario: {
      control: "select",
      options: [
        "saved",
        "saving",
        "failed",
        "empty",
        "loading",
        "unavailable",
        "uploadFailed",
      ],
    },
  },
  render: ({ scope, scenario }) => (
    <WorkFolderStoryProvider key={`${scope}:${scenario}`} scenario={scenario}>
      <div className="mx-auto max-w-5xl">
        <p className="mb-4 text-sm text-muted-foreground">
          Editable stored-file prototype — editing controls are not exposed in the app. These are saved
          copies, not the live sandbox filesystem.
        </p>
        <WorkFolderBrowser owner={workFolderOwners[scope]} />
      </div>
    </WorkFolderStoryProvider>
  ),
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BrowseAndManage: Story = {};
export const MarkdownPreview: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText("README.md"));
    await expect(
      within(canvasElement).getByRole("link", { name: "Download" }),
    ).toBeVisible();
  },
};
export const NestedCodePreview: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByText("scripts"));
    await userEvent.click(await c.findByText("verify.sh"));
  },
};
export const ImagePreview: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByText("assets"));
    await userEvent.click(await c.findByText("paperclip.png"));
  },
};
export const EmptyFilePreview: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText("empty.txt"));
  },
};
export const UnsupportedPreview: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByText("archive.zip"),
    );
  },
};
export const LargeFilePreview: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByText("recording.mp4"),
    );
  },
};
export const EmptyFolder: Story = { args: { scenario: "empty" } };
export const Loading: Story = { args: { scenario: "loading" } };
export const Saving: Story = { args: { scenario: "saving" } };
export const SaveFailed: Story = { args: { scenario: "failed" } };
export const StorageUnavailable: Story = { args: { scenario: "unavailable" } };
export const UploadFailed: Story = {
  args: { scenario: "uploadFailed" },
  play: async ({ canvasElement }) => {
    await userEvent.upload(
      await within(canvasElement).findByLabelText("Upload work files"),
      new File(["review notes"], "review.md", { type: "text/markdown" }),
    );
  },
};
export const Trash: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      await within(canvasElement).findByRole("tab", { name: "Trash" }),
    );
  },
};
export const PurgeConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(await c.findByRole("tab", { name: "Trash" }));
    await userEvent.click(await c.findByRole("button", { name: "Purge…" }));
  },
};
export const UploadDeleteRestore: Story = {
  parameters: {
    docs: {
      description: {
        story:
          "Exercises the real controls against a fresh fixture: upload a file, delete it, and restore it from Trash. Ends on the restored file list for further exploration.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.upload(
      await c.findByLabelText("Upload work files"),
      new File(["# Review\n\nReady for design feedback."], "review.md", {
        type: "text/markdown",
      }),
    );
    await userEvent.click(await c.findByText("review.md"));
    await userEvent.click((await c.findByRole("treeitem", { name: "review.md" })).querySelector("input")!);
    await userEvent.click(await c.findByRole("button", { name: "Move 1 file to trash" }));
    await userEvent.click(c.getByRole("tab", { name: "Trash" }));
    const row = (await c.findByText("review.md")).parentElement!;
    await userEvent.click(within(row).getByRole("button", { name: "Restore" }));
    await userEvent.click(c.getByRole("tab", { name: "Files" }));
    await expect(await c.findByText("review.md")).toBeVisible();
  },
};
export const EmptyTrash: Story = {
  args: { scenario: "empty" },
  play: Trash.play,
};
export const MobileBrowser: Story = {
  globals: { viewport: { value: "mobile" } },
};
export const LightBrowser: Story = {
  globals: { theme: "light" },
  play: MarkdownPreview.play,
};
