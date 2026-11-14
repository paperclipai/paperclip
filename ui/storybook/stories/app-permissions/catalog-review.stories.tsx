import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ToolCatalogEntry } from "@paperclipai/shared";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";
import { expect, userEvent, within } from "storybook/test";
const entry: ToolCatalogEntry = {
  id: "catalog-gap",
  companyId: "company-storybook",
  applicationId: null,
  connectionId: "connection-gap",
  entryKind: "tool",
  toolName: "publish_release",
  title: "Publish release",
  description: "Publish the approved release notes.",
  inputSchema: { type: "object" },
  outputSchema: null,
  annotations: null,
  riskLevel: "write",
  isReadOnly: false,
  isWrite: true,
  isDestructive: false,
  status: "quarantined",
  addedAt: new Date("2026-10-12"),
  version: null,
  schemaHash: null,
  firstSeenAt: new Date("2026-10-12"),
  lastSeenAt: new Date("2026-10-12"),
  reviewedAt: null,
  reviewedByAgentId: null,
  reviewedByUserId: null,
  createdAt: new Date("2026-10-12"),
  updatedAt: new Date("2026-10-12"),
};
function CatalogReview({
  state = "ready",
}: {
  state?: "ready" | "empty" | "refreshing" | "saving" | "readonly";
}) {
  const [quarantined, setQuarantined] = useState(
    state === "empty" ? [] : [entry],
  );
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(state === "refreshing");
  return (
    <ActionsSection
      connectionId="connection-gap"
      appName="Release tools"
      readOnly={[]}
      canChange={
        state === "empty" || quarantined.length
          ? []
          : [{ ...entry, status: "active" }]
      }
      quarantined={quarantined}
      enabledIds={enabled}
      askFirstIds={new Set()}
      disabled={state === "saving"}
      refreshPending={refreshing}
      canConfigure={state !== "readonly"}
      onReviewQuarantined={(ids) => {
        setEnabled(new Set(ids));
        setQuarantined([]);
      }}
      onRefreshActions={() => {
        setRefreshing(false);
        setQuarantined([entry]);
      }}
      onSetPermission={(ids, next) =>
        setEnabled(new Set(next === "allowed" ? ids : []))
      }
    />
  );
}
const meta = {
  id: "feature-catalog-review",
  title:
    "Apps, channels, and extensions/App access and action permissions/Review newly discovered actions",
  component: CatalogReview,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Shipped action section and quarantine reviewer with local catalog props. Discovery failures belong to the owning AppDetail API boundary; permissions and review persistence need production checks.",
      },
    },
    paperclip: {
      "capabilities": [
        "app-permissions/catalog-change"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Shipped ActionsSection quarantine reviewer with allowed/blocked decisions, empty/refreshing/saving/read-only props. Callbacks simulate catalog persistence; discovery failures belong to AppDetail and backend authority remains separate."
    },
  },
} satisfies Meta<typeof CatalogReview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Quarantined: Story = {};
export const Empty: Story = { args: { state: "empty" } };
export const Refreshing: Story = { args: { state: "refreshing" } };
export const Saving: Story = { args: { state: "saving" } };
export const ReadOnly: Story = { args: { state: "readonly" } };
export const ReviewAndAllow: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(
      c.getByRole("switch", { name: "Publish release allowed" }),
    );
    await userEvent.click(c.getByRole("button", { name: "Save choices" }));
    await expect(c.queryByText("Review 1 new action")).not.toBeInTheDocument();
    await c.findByText("Publish release");
  },
};
export const LeaveBlocked: Story = {
  play: async ({ canvasElement }) => {
    const c = within(canvasElement);
    await userEvent.click(c.getByRole("button", { name: "Save choices" }));
    await expect(c.queryByText("Review 1 new action")).not.toBeInTheDocument();
  },
};
