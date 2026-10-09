import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ConnectionPoolConnectorHost } from "../prototypes/ConnectionPoolConnectorHost";
const meta = { title: "Connectors/Pool host", component: ConnectionPoolConnectorHost, parameters: { layout: "fullscreen" } } satisfies Meta<typeof ConnectionPoolConnectorHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Catalog: Story = {};
export const Setup: Story = { args: { scenario: "setup" } };
export const OperatorSetupRequired: Story = { args: { scenario: "unavailable" }, play: async ({ canvasElement }) => {
  const add = await within(canvasElement).findByRole("button", { name: "Add connection pool AI connection pool" });
  await expect(add).toBeDisabled();
  await expect(add).toHaveAttribute("title", "Ask your instance operator to enable AI connection routing.");
} };
export const Manage: Story = { args: { scenario: "manage" }, play: async ({ canvasElement }) => {
  const usedBy = within(await within(canvasElement).findByRole("region", { name: "Used by" }));
  await expect(await usedBy.findByRole("link", { name: "Researcher" })).toBeVisible();
  await expect(usedBy.getByRole("link", { name: "Writer" })).toBeVisible();
  await expect(usedBy.getAllByRole("link")).toHaveLength(2);
} };
export const CreateFromConnectors: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click(await c.findByRole("button", { name: "Add connection pool AI connection pool" }));
  await userEvent.click(await c.findByRole("checkbox", { name: "My ChatGPT account" }));
  await userEvent.click(c.getByRole("checkbox", { name: "My Claude account" }));
  await userEvent.click(c.getByRole("button", { name: "Continue" }));
  await userEvent.click(c.getByRole("button", { name: "Move My Claude account up" }));
  await expect(within(c.getByRole("list", { name: "Connection order" })).getAllByRole("listitem")[0]).toHaveTextContent("My Claude account");
  await userEvent.click(c.getByRole("button", { name: "Create pool" }));
  await expect(await c.findByRole("checkbox", { name: "Enable this pool" })).not.toBeChecked();
  await expect(c.getByRole("heading", { level: 1, name: "AI connection pool" })).toBeVisible();
  await expect(await within(c.getByRole("region", { name: "Used by" })).findByText("No agents yet.")).toBeVisible();
} };
