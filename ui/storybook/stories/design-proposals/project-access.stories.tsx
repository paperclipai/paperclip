import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ProjectAccessProposal } from "../../support/design-proposals/ProjectAccessProposal";

const meta = {
  id: "design-project-access",
  title: "Design proposals/Patterns/Project access recovery",
  component: ProjectAccessProposal,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues/DEMO-42"],
    docs: { description: { component: "Start at Blocked task. Manage project access opens the proposed agent settings. Add Agent Extensions, review the additive access change, save, return to the task and retry. Low-trust review stays active. Settings supports multiple allowed projects without replacing the existing one. Read-only, pending save, failed save and failed retry states remain actionable. The reply and every state transition are local fixtures; no project permissions change and no provider runs. Reset the story to restore the starting state." } },
    paperclip: {
      capabilities: ["recovery/diagnosis", "recovery/source-action", "agents/instructions"],
      home: "design-proposals", status: "proposed",
      exception: "Requested design for a visible project denial and additive project access repair before production implementation.",
      implementation: "prototype", boundary: "fixtures",
      notes: "Reuses DesignPageShell, DesignSidebar, AgentAvatar, IssueStatusBadge, TaskChatBubble, TaskChatLiveRunPill and shared form primitives. Notice, access editor and navigation are a local prototype. Synthetic names and repositories only. Save retains existing projects; failed saves preserve draft but grant nothing. Retry is unavailable before a saved grant and does not run on save. Read-only viewers cannot edit. No production API, persistence, permission, provider or recovery proof. The implemented notice and editor are covered by the task-project-access stories; this retains the original design snapshot. Server regression tests and application verification cover authorization, persistence and explicit retry separately.",
    },
  },
} satisfies Meta<typeof ProjectAccessProposal>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BlockedTask: Story = {};
export const AgentSettings: Story = { args: { initialView: "permissions" } };
export const AccessSaved: Story = { args: { initialState: "access_saved" } };
export const ReadOnly: Story = { args: { canManage: false }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText("Reviewer can’t access this project")).toBeVisible();
  await expect(canvas.queryByRole("button", { name: "Manage project access" })).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole("button", { name: "View agent access" }));
  await expect(canvas.getByText("Only people with agent configuration permission can change this access.")).toBeVisible();
  await expect(canvas.queryByRole("button", { name: "Add project" })).not.toBeInTheDocument();
} };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MobileSettings: Story = { args: { initialView: "permissions" }, globals: { viewport: { value: "mobile1", isRotated: false } } };

async function addProject(canvasElement: HTMLElement, name = "Agent Extensions") {
  const canvas = within(canvasElement), screen = within(canvasElement.ownerDocument.body);
  await userEvent.click(await canvas.findByRole("button", { name: "Add project" }));
  await userEvent.click(await screen.findByRole("checkbox", { name }));
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
}

export const RepairJourney: Story = { play: async ({ canvasElement, step }) => {
  const canvas = within(canvasElement);
  await step("Explain the denied project before any provider work", async () => {
    await expect(await canvas.findByText("Reviewer can’t access this project")).toBeVisible();
    await expect(canvas.getByRole("alert")).toHaveTextContent("The agent hasn’t started. Your message is saved.");
    await expect(canvas.queryByRole("button", { name: "Retry task" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Manage project access" }));
  });
  await step("Add a project while preserving existing containment", async () => {
    await expect(canvas.getByRole("button", { name: "Save project access" })).toBeDisabled();
    await addProject(canvasElement);
    await expect(canvas.getByTestId("project-product")).toHaveTextContent("Allowed");
    await expect(canvas.getByTestId("project-extensions")).toHaveTextContent("To add");
    await expect(canvas.getByText("Low-trust review", { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
    await expect(await canvas.findByText("Project access saved.")).toBeVisible();
    await expect(canvas.getByTestId("project-product")).toHaveTextContent("Allowed");
    await expect(canvas.getByTestId("project-extensions")).toHaveTextContent("Allowed");
  });
  await step("Explicitly retry the saved message after saving access", async () => {
    await userEvent.click(canvas.getByRole("button", { name: "Return to task" }));
    await expect(canvas.getByText("Project access is ready")).toBeVisible();
    await waitFor(() => expect(canvas.getByText("Are you there?")).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Retry task" }));
    await waitFor(() => expect(canvas.getByText("Yes, I’m here. What would you like me to look at?")).toBeVisible());
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  });
} };

export const CancelJourney: Story = { args: { initialView: "permissions" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await addProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
  await expect(canvas.getByText("Reviewer can’t access this project")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Manage project access" }));
  await expect(canvas.queryByTestId("project-extensions")).not.toBeInTheDocument();
  await expect(canvas.getByTestId("project-product")).toHaveTextContent("Allowed");
} };

export const SaveFailure: Story = { args: { initialView: "permissions", failSave: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await addProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
  await expect(await canvas.findByRole("alert")).toHaveTextContent("No permissions changed. Your selection is kept.");
  await expect(canvas.getByTestId("project-extensions")).toHaveTextContent("To add");
  await expect(canvas.getByTestId("project-product")).toHaveTextContent("Allowed");
} };
export const SaveFailureJourney: Story = { args: { initialView: "permissions", failSave: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await addProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
  await userEvent.click(await canvas.findByRole("button", { name: "Try saving again" }));
  await expect(await canvas.findByText("Project access saved.")).toBeVisible();
  await expect(canvas.getByTestId("project-extensions")).toHaveTextContent("Allowed");
} };
export const Saving: Story = { args: { initialView: "permissions", holdSaving: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await addProject(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
  await expect(canvas.getByRole("button", { name: "Saving access…" })).toBeDisabled();
  await expect(canvas.getByRole("button", { name: "Cancel" })).toBeDisabled();
} };
export const RetryFailure: Story = { args: { initialState: "access_saved", failRetry: true }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Retry task" }));
  await expect(await canvas.findByRole("alert")).toHaveTextContent("Couldn’t start the retry. Project access is saved.");
} };
export const MultipleProjects: Story = { args: { initialView: "permissions" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await addProject(canvasElement);
  await addProject(canvasElement, "Website");
  await userEvent.click(canvas.getByRole("button", { name: "Save project access" }));
  await expect(await canvas.findByText("Project access saved.")).toBeVisible();
  for (const id of ["product", "extensions", "website"]) await expect(canvas.getByTestId(`project-${id}`)).toHaveTextContent("Allowed");
} };
