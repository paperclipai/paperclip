import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { PrimaryPage, primaryDecorator, primaryParameters } from "./PrimaryAgentStory";

async function openActions(canvasElement: HTMLElement, name: string, profile = false) {
  const page = within(canvasElement.ownerDocument.body);
  const buttons = await page.findAllByRole("button", { name: `Open actions for ${name}` });
  const button = (profile ? buttons[buttons.length - 1] : buttons[0])!;
  button.focus();
  await userEvent.keyboard("{Enter}");
  return page;
}
const maiaProfile = { initialEntries: ["/PAP/agents/maia"] };
export default { title: "Primary Agent/06 Journeys", decorators: [primaryDecorator], parameters: { ...primaryParameters, initialEntries: ["/PAP/agents/alex"] }, render: () => <PrimaryPage /> } satisfies Meta;
type Story = StoryObj;
async function confirmPrimaryChange(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("button", { name: "Set as my primary" }));
  const dialog = within(await page.findByRole("alertdialog", { name: "Change your primary agent?" }));
  await expect(dialog.getByText("This will make Alex your primary agent, do you want to do this?")).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Maia avatar" })).toBeVisible();
  await expect(dialog.getByRole("img", { name: "Alex avatar" })).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Set as my primary" }));
  return page;
}
export const SwitchPrimary: Story = { play: async ({ canvasElement }) => {
  const page = await confirmPrimaryChange(canvasElement);
  await waitFor(() => expect(page.queryByRole("button", { name: "Setting primary…" })).not.toBeInTheDocument());
  await expect(within(page.getByRole("main")).getByRole("img", { name: "My primary agent" })).toBeVisible();
  await expect(page.queryByRole("button", { name: "Set as my primary" })).not.toBeInTheDocument();
} };
export const PrimaryHasNoUnsetAction: Story = { parameters: maiaProfile, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await expect(await page.findByRole("img", { name: "My primary agent" })).toBeVisible();
  await expect(page.queryByRole("button", { name: "Set as my primary" })).not.toBeInTheDocument();
  await openActions(canvasElement, "Maia", true);
  await expect(page.queryByRole("button", { name: /primary/i })).not.toBeInTheDocument();
} };
export const FailedSaveRestoresCrown: Story = { parameters: { primaryAgent: { failNext: true } }, play: async ({ canvasElement }) => {
  const page = await confirmPrimaryChange(canvasElement);
  await waitFor(() => expect(page.getByText("Couldn't change your primary agent")).toBeVisible());
  await expect(within(page.getByRole("main")).queryByRole("img", { name: "My primary agent" })).not.toBeInTheDocument();
  await expect(page.getByRole("button", { name: "Set as my primary" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
} };
export const StarDoesNotMoveCrown: Story = { parameters: maiaProfile, play: async ({ canvasElement }) => {
  const page = await openActions(canvasElement, "Jules");
  await userEvent.click(await page.findByText("Star agent"));
  await openActions(canvasElement, "Jules");
  await expect(await page.findByText("Remove from starred")).toBeVisible();
  await expect(page.queryByRole("menuitem", { name: /primary/i })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect(within(page.getByRole("main")).getByRole("img", { name: "My primary agent" })).toBeVisible();
} };
export const LeavePrimary: Story = { parameters: maiaProfile, play: async ({ canvasElement }) => {
  const page = await openActions(canvasElement, "Maia");
  await userEvent.click(await page.findByText("Leave agent"));
  await waitFor(() => expect(page.queryAllByRole("img", { name: "My primary agent" })).toHaveLength(0));
  await expect(await page.findByRole("button", { name: "Set as my primary" })).toBeVisible();
} };
export const SwitchThenStartTask: Story = { play: async context => {
  await SwitchPrimary.play!(context);
  const page = within(context.canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole("button", { name: "New Task" }));
  await expect(await page.findByRole("dialog")).toBeVisible();
  await expect(await page.findByRole("button", { name: "Select assignee" })).toHaveTextContent("Alex");
} };
export const RetryFailedSave: Story = { ...FailedSaveRestoresCrown, play: async context => {
  await FailedSaveRestoresCrown.play!(context);
  const page = within(context.canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(page.queryByRole("button", { name: "Setting primary…" })).not.toBeInTheDocument());
  await expect(within(page.getByRole("main")).getByRole("img", { name: "My primary agent" })).toBeVisible();
} };
export const SwitchThenOpenChat: Story = { play: async context => {
  await SwitchPrimary.play!(context);
  const page = within(context.canvasElement.ownerDocument.body);
  await userEvent.click(page.getByRole("link", { name: "Chat" }));
  await expect(await page.findByText("Message Alex — describe what you want done…")).toBeVisible();
  await expect(page.queryAllByRole("img", { name: "My primary agent" })).toHaveLength(0);
} };
export const ProfileActionOnly: Story = { play: async ({ canvasElement }) => {
  const page = await openActions(canvasElement, "Alex");
  await expect(page.queryByRole("menuitem", { name: /primary/i })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await openActions(canvasElement, "Alex", true);
  await expect(within(page.getByRole("dialog")).queryByRole("button", { name: /primary/i })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect(page.getByRole("button", { name: "Set as my primary" })).toBeVisible();
} };
export const CancelKeepsPrimary: Story = { play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("button", { name: "Set as my primary" }));
  const dialog = within(await page.findByRole("alertdialog"));
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(page.queryByRole("alertdialog")).not.toBeInTheDocument());
  await expect(page.getByRole("button", { name: "Set as my primary" })).toHaveFocus();
  await expect(within(page.getByRole("main")).queryByRole("img", { name: "My primary agent" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("link", { name: "See all agents" }));
  await expect(await page.findByRole("link", { name: /^Maia My primary agent/ })).toBeVisible();
} };
export const FirstChoiceNeedsNoConfirmation: Story = { parameters: { primaryAgent: { primaryId: null } }, play: async ({ canvasElement }) => {
  const page = within(canvasElement.ownerDocument.body);
  await userEvent.click(await page.findByRole("button", { name: "Set as my primary" }));
  await expect(page.queryByRole("alertdialog")).not.toBeInTheDocument();
  await waitFor(() => expect(page.queryByRole("button", { name: "Setting primary…" })).not.toBeInTheDocument());
  await expect(within(page.getByRole("main")).getByRole("img", { name: "My primary agent" })).toBeVisible();
} };
