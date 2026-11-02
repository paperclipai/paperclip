import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { BulkAgentSettingsProposal } from "../../support/design-proposals/BulkAgentSettingsProposal";

const meta = {
  id: "design-bulk-agent-settings",
  title: "Design proposals/Pages/Agents/Bulk connection and model",
  component: BulkAgentSettingsProposal,
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/agents/all"],
    docs: { description: { component: "Start in Playground: filter by harness, select rows, then Edit connection & model. Mixed selections offer a separate action for each harness. Each field is opt-in, with a per-agent before/after preview and a count excluding agents already at the target value. Connection selection uses the production AiConnectionSelect; ModelDropdown offers the intersection of fixture model availability. Incompatible models block saving without silently replacing them. Save updates local roster state, and Partial failure allows retry of only the unsuccessful agent. All accounts, catalogs, saves and failures are synthetic. Future-run timing and preserving task overrides are proposed behavior, not production acceptance. Reload/reset the story to restore its fixtures." } },
    paperclip: {
      capabilities: ["agents/instructions", "agents/organization"],
      home: "design-proposals", status: "proposed",
      exception: "Requested interactive bulk-settings design for review before production implementation.",
      implementation: "prototype", boundary: "fixtures",
      notes: "Reuses DesignPageShell, DesignSidebar, AgentsToolbar, AgentAvatar, AiConnectionSelect, ModelDropdown, Checkbox and Sheet. Local roster, selection, harness grouping, model intersections, validation and save/retry state are prototype-only. No API mutations, account creation, grants or agent runs. Model catalogs are synthetic, not live provider promises. External agents cannot be selected. Filtering preserves selection and names hidden selections. Checked fields alone change; no-op agents are excluded. Dark/light toolbar and responsive sheet available. Backend authorization, grant availability for every agent, concurrency/revision checks, durable partial receipts and execution/session semantics require implementation after design review.",
    },
  },
} satisfies Meta<typeof BulkAgentSettingsProposal>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const CodexSelected: Story = { args: { selection: "codex" } };
export const MixedHarnesses: Story = { args: { selection: "mixed" } };
export const ChangeConnection: Story = { args: { selection: "codex", editor: "connection" } };
export const ChangeDefaultModel: Story = { args: { selection: "codex", editor: "model" } };
export const ChangeBoth: Story = { args: { selection: "codex", editor: "both" } };
export const IncompatibleModel: Story = { args: { selection: "codex", editor: "incompatible" } };
export const PartialFailure: Story = { args: { selection: "codex", editor: "connection", failOne: true } };
export const Light: Story = { args: { selection: "mixed" }, globals: { theme: "light" } };
export const MobileEditor: Story = { args: { selection: "codex", editor: "both" }, globals: { viewport: { value: "mobile1", isRotated: false } } };

export const ConnectionJourney: Story = {
  args: { selection: "mixed" },
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);
    const screen = within(canvasElement.ownerDocument.body);
    await step("Mixed selection explicitly scopes the change to Codex", async () => {
      await userEvent.click(await canvas.findByRole("button", { name: "Edit 4 Codex" }));
      await expect(screen.getByText("2 other selected agents won’t change.")).toBeVisible();
      await expect(screen.getByRole("button", { name: "Update 4 agents" })).toBeDisabled();
    });
    await step("Changing only the connection keeps every model", async () => {
      await userEvent.click(screen.getByRole("checkbox", { name: "Change connection" }));
      await userEvent.click(screen.getByRole("combobox", { name: "Connection" }));
      await userEvent.click(screen.getByRole("option", { name: /^OpenAI · Production ·/ }));
      await userEvent.click(screen.getByRole("button", { name: "Update 4 agents" }));
      await expect(await canvas.findByText("Updated 4 Codex agents.")).toBeVisible();
      await expect(canvas.getByTestId("agent-row-scout")).toHaveTextContent("gpt-5.3-codex");
      await expect(canvas.getByTestId("agent-row-scout")).toHaveTextContent("OpenAI · Production");
      await expect(canvas.getByTestId("agent-row-sage")).toHaveTextContent("Anthropic · Team");
      await expect(canvas.getByText("2 selected")).toBeVisible();
    });
  },
};

export const ModelJourney: Story = {
  args: { selection: "codex", editor: "model" },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await screen.findByRole("button", { name: "Model" }));
    await userEvent.click(screen.getByRole("option", { name: "gpt-5.5" }));
    await expect(screen.getByText("1 already has these settings.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Update 3 agents" }));
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Updated 3 Codex agents.")).toBeVisible();
    await expect(canvas.getByTestId("agent-row-scout")).toHaveTextContent("gpt-5.5");
    await expect(canvas.getByTestId("agent-row-scout")).toHaveTextContent("OpenAI · Engineering");
  },
};

export const CompatibilityJourney: Story = {
  args: { selection: "codex", editor: "incompatible" },
  play: async ({ canvasElement, step }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await step("A connection change cannot silently replace an incompatible model", async () => {
      await expect(await screen.findByText("Scout needs a compatible model")).toBeVisible();
      await expect(screen.getByRole("button", { name: "Update 4 agents" })).toBeDisabled();
      await userEvent.click(screen.getByRole("button", { name: "Change default model" }));
      await userEvent.click(screen.getByRole("button", { name: "Model" }));
      await expect(screen.queryByRole("option", { name: "gpt-5.3-codex" })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("option", { name: "gpt-5.5" }));
      await expect(screen.queryByText("Scout needs a compatible model")).not.toBeInTheDocument();
      await expect(screen.getByRole("button", { name: "Update 4 agents" })).toBeEnabled();
    });
    await step("Cancel leaves both settings untouched", async () => {
      await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
      const row = within(canvasElement).getByTestId("agent-row-scout");
      await expect(row).toHaveTextContent("OpenAI · Engineering");
      await expect(row).toHaveTextContent("gpt-5.3-codex");
    });
  },
};

export const RetryJourney: Story = {
  args: { selection: "codex", editor: "connection", failOne: true },
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await screen.findByRole("combobox", { name: "Connection" }));
    await userEvent.click(screen.getByRole("option", { name: /^OpenAI · Production ·/ }));
    await userEvent.click(screen.getByRole("button", { name: "Update 4 agents" }));
    await expect(await screen.findByText("3 updated · 1 couldn’t be saved")).toBeVisible();
    await expect(within(canvasElement).getByTestId("agent-row-atlas")).toHaveTextContent("OpenAI · Production");
    await expect(within(canvasElement).getByTestId("agent-row-scout")).toHaveTextContent("OpenAI · Engineering");
    await userEvent.click(screen.getByRole("button", { name: "Retry 1 agent" }));
    await expect(await within(canvasElement).findByText("Updated 4 Codex agents.")).toBeVisible();
    await expect(within(canvasElement).getByTestId("agent-row-scout")).toHaveTextContent("OpenAI · Production");
  },
};
