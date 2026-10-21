import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Routes, Route } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { AuditHub } from "@/pages/audit/AuditHub";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { commentaryEntries, prepareCommentaryFixtures } from "../../support/agent-commentary/fixtures";

function CommentaryJourney() {
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}><Route path="activity/commentary" element={<AuditHub section="commentary" />} /><Route path="activity" element={<AuditHub section="activity" />} /></Route></Routes></PluginLauncherProvider>;
}

const meta = {
  id: "agent-commentary",
  title: "Oversight and operation/Dashboards and audit trails/Commentary",
  component: CommentaryJourney,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/activity/commentary"],
    paperclip: {
      capabilities: ["activity/agent-commentary"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production Audit shell, commentary page, filters and modal. Synthetic feedback; API filtering, pagination and details are simulated. Server authorization is verified separately.",
    },
  },
  beforeEach: ({ parameters }) => prepareCommentaryFixtures(parameters.commentary ?? {}).cleanup,
} satisfies Meta<typeof CommentaryJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Messages: Story = {};
export const ReadMessage: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    const existingDialog = body.queryByRole("dialog");
    if (existingDialog) await userEvent.click(within(existingDialog).getByRole("button", { name: "Close" }));
    const rows = await within(canvasElement).findAllByRole("button", { name: "Read suggestion from Amy (Opus)" });
    await userEvent.click(rows[0]);
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
    await expect(await within(dialog).findByText("What would help")).toBeVisible();
    await expect(within(dialog).getByRole("link", { name: "View run" }).getAttribute("href")).toContain("/runs/");
  },
};
export const FilterByAgentAndType: Story = {
  parameters: { initialEntries: ["/PAP/activity/commentary?agentId=10000000-0000-4000-8000-000000000001&kind=complaint"] },
  play: async ({ canvasElement }) => { await expect(await within(canvasElement).findByText("1–1 of 1 messages")).toBeVisible(); },
};
export const SearchMessages: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole("textbox", { name: "Search commentary" }), "evidence");
    await userEvent.click(canvas.getByRole("combobox", { name: "Filter by agent" }));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("option", { name: "Amy (Opus)" }));
    await expect(await canvas.findByText("1–1 of 1 messages")).toBeVisible();
    await expect(canvas.getByRole("combobox", { name: "Filter by agent" })).toHaveTextContent("Amy (Opus)");
  },
};
export const LinkedMessage: Story = {
  parameters: { initialEntries: [`/PAP/activity/commentary?entry=${commentaryEntries[0].id}`] },
  play: async ({ canvasElement }) => {
    const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog");
    await expect(await within(dialog).findByText("What would help")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await expect(within(canvasElement).getByRole("list", { name: "Commentary messages" })).toBeVisible();
  },
};
export const LongMessage: Story = { parameters: { commentary: { longMessage: true }, initialEntries: [`/PAP/activity/commentary?entry=${commentaryEntries[0].id}`] } };
export const Pagination: Story = { parameters: { commentary: { paginated: true } }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByText("1–50 of 58 messages")).toBeVisible();
  await expect(within(canvas.getByRole("list", { name: "Commentary messages" })).getAllByRole("listitem")).toHaveLength(50);
  await userEvent.click(await canvas.findByRole("button", { name: "Next page" }));
  await expect(await canvas.findByText("51–58 of 58 messages")).toBeVisible();
} };
export const Empty: Story = { parameters: { commentary: { state: "empty" } } };
export const NoMatches: Story = { parameters: { initialEntries: ["/PAP/activity/commentary?q=no-matching-message"] } };
export const Loading: Story = { parameters: { commentary: { state: "loading" } } };
export const Failed: Story = { parameters: { commentary: { state: "failure" } } };
export const PermissionDenied: Story = { parameters: { commentary: { state: "permission" } } };
export const Mobile: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, parameters: { waitForViewport: true } };
export const Light: Story = { globals: { theme: "light" } };
