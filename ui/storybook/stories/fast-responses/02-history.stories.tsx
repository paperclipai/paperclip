import type { Meta, StoryObj } from "@storybook/react-vite";
import type { FastResponseHistoryEntry } from "@paperclipai/shared";
import { DecisionHistoryTable } from "@/components/decision-models/DecisionHistory";
import { entry } from "../decision-models/fixtures";
const receipt: FastResponseHistoryEntry = {
  ...entry,
  feature: "message",
  model: "openai/gpt-oss-120b",
  provider: "openrouter",
  connectionName: "Company OpenRouter",
  publicationStatus: "published",
  durationMs: 1013,
  inputTokens: 261,
  outputTokens: 38,
  costCents: "0.006195",
  costStatus: "reported",
};
const meta = {
  title: "Fast responses/02 History",
  component: DecisionHistoryTable,
  decorators: [
    (Story) => (
      <main className="p-6">
        <Story />
      </main>
    ),
  ],
  args: { entries: [receipt], fastResponse: true },
} satisfies Meta<typeof DecisionHistoryTable>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { entries: [] } };
export const Published: Story = {};
export const MixedOutcomes: Story = {
  args: {
    entries: [
      receipt,
      {
        ...receipt,
        id: "sponsored",
        actorType: "system",
        responsibleUserId: null,
        userName: null,
      },
      { ...receipt, id: "superseded", publicationStatus: "suppressed" },
      {
        ...receipt,
        id: "unknown",
        status: "unknown",
        publicationStatus: "suppressed",
        errorCode: "timeout",
        costStatus: "unpriced",
        costCents: null,
        durationMs: 3000,
        inputTokens: null,
        outputTokens: null,
      },
      {
        ...receipt,
        id: "expired",
        status: "skipped",
        publicationStatus: "suppressed",
        errorCode: "expired",
        connectionName: null,
        connectionId: "",
        model: "",
        costStatus: null,
        costCents: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  },
};
export const Mobile: Story = {
  ...MixedOutcomes,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
