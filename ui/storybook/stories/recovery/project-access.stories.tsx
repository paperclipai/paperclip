import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { AllowedProjectsEditor } from "@/components/AllowedProjectsEditor";
import { ProjectAccessNotice } from "@/components/ProjectAccessNotice";

const meta = {
  id: "task-project-access",
  title: "Projects and execution/Recovery/Task chat/Project access",
  component: ProjectAccessNotice,
  parameters: { paperclip: {
    capabilities: ["recovery/diagnosis", "agents/instructions"], implementation: "production", boundary: "fixtures",
    notes: "Production notice and additive project editor. Local save callbacks cover selection, read-only, cancellation and failed-save states. API authorization, persistence and explicit retry admission are separate server regressions and local application verification.",
  } },
  decorators: [(Story) => <div className="mx-auto max-w-2xl space-y-4 p-4"><Story /></div>],
  args: { agentName: "Reviewer", projectName: "Agent Extensions", ready: false, canManage: true, canRetry: false, onManage: fn(), onRetry: fn() },
} satisfies Meta<typeof ProjectAccessNotice>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BlockedTask: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("alert")).toHaveTextContent("Your message is saved.");
  await expect(canvas.queryByRole("button", { name: "Retry task" })).not.toBeInTheDocument();
  await expect(canvas.getByRole("button", { name: "Manage project access" })).toBeVisible();
} };
export const AccessSaved: Story = { args: { ready: true, canRetry: true } };
export const ReadOnly: Story = { args: { canManage: false } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };

const projects = [{ id: "product", name: "Product" }, { id: "extensions", name: "Agent Extensions" }, { id: "website", name: "Website" }];
function Editor({ fail = false, canManage = true }: { fail?: boolean; canManage?: boolean }) {
  const [ids, setIds] = useState(["product"]);
  const [failed, setFailed] = useState(false);
  return <AllowedProjectsEditor agentName="Reviewer" projects={projects} projectIds={ids} canManage={canManage}
    onSave={async added => {
      if (fail && !failed) { setFailed(true); throw new Error("Connection interrupted."); }
      setIds(current => [...new Set([...current, ...added])]);
    }} />;
}
async function selectProject(canvasElement: HTMLElement) {
  const canvas = within(canvasElement), screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(canvas.getByRole("button", { name: "Add project" }));
  await expect(await screen.findByRole("checkbox", { name: "Product" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "Agent Extensions" }));
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
}
export const AgentSettings: Story = { render: () => <Editor /> };
export const SaveAccess: Story = { ...AgentSettings, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await selectProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
  await expect(await canvas.findByRole("status")).toHaveTextContent("Project access saved");
  await expect(canvas.getAllByText("Allowed", { exact: true })).toHaveLength(2);
  await expect(canvas.queryByRole("button", { name: "Retry task" })).not.toBeInTheDocument();
} };
export const CancelAddition: Story = { ...AgentSettings, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await selectProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
  await expect(canvas.queryByText("Agent Extensions", { exact: true })).not.toBeInTheDocument();
  await expect(canvas.getByText("Product")).toBeVisible();
} };
export const SaveFailure: Story = { render: () => <Editor fail />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await selectProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
  await expect(await canvas.findByRole("alert")).toHaveTextContent("Your selection is kept");
  await expect(canvas.getByText("To add")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Try saving again" }));
  await expect(await canvas.findByRole("status")).toHaveTextContent("Project access saved");
} };
export const ReadOnlySettings: Story = { render: () => <Editor canManage={false} />, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).queryByRole("button", { name: "Add project" })).not.toBeInTheDocument();
} };
export const MobileSettings: Story = { ...AgentSettings, globals: { viewport: { value: "mobile1", isRotated: false } } };
