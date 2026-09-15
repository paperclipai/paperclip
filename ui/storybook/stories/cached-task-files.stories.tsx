import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CachedTaskFilesButton } from "@/components/CachedTaskFilesButton";
import { WorkFolderStoryProvider, workFolderTask } from "../fixtures/WorkFolderStoryProvider";

const meta = {
  title: "Work folders/Cached task inspector",
  component: CachedTaskFilesButton,
  args: { issue: workFolderTask, currentUserId: "user-board" },
  decorators: [(Story) => <WorkFolderStoryProvider><Story /></WorkFolderStoryProvider>],
} satisfies Meta<typeof CachedTaskFilesButton>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BrowseCachedContext: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("button", { name: "View cached files" }));
    await expect(page.getByRole("dialog", { name: "Cached task files" })).toBeVisible();
    for (const scope of ["Task", "Project", "Agent", "Responsible user"]) {
      await userEvent.click(page.getByRole("tab", { name: scope }));
      await userEvent.click(await page.findByRole("treeitem", { name: "README.md" }));
      await expect(page.getByRole("link", { name: "Download" })).toBeVisible();
      await expect(page.queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
    }
    await userEvent.click(page.getByRole("tab", { name: "Task" }));
  },
};
export const PrivateResponsibleUser: Story = {
  args: { currentUserId: "another-user" },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("button", { name: "View cached files" }));
    await userEvent.click(page.getByRole("tab", { name: "Responsible user" }));
    await expect(page.getByText("These cached files are private to the responsible user.")).toBeVisible();
    await expect(page.queryByRole("tree")).not.toBeInTheDocument();
  },
};
export const UnboundProject: Story = {
  args: { issue: { ...workFolderTask, projectId: null } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(page.getByRole("button", { name: "View cached files" }));
    await userEvent.click(page.getByRole("tab", { name: "Project" }));
    await expect(page.getByText("No project is bound to this task. This folder is empty and unbound.")).toBeVisible();
    await expect(page.queryByRole("tree")).not.toBeInTheDocument();
  },
};
