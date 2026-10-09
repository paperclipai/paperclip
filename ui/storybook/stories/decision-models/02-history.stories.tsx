import type { Meta, StoryObj } from "@storybook/react-vite";
import { DecisionHistoryTable } from "@/components/decision-models/DecisionHistory";
import { entry } from "./fixtures";

const meta = { title: "Decision models/02 History", component: DecisionHistoryTable,
  decorators: [Story => <main className="p-6"><Story /></main>], args: { entries: [entry] },
} satisfies Meta<typeof DecisionHistoryTable>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { entries: [] } };
export const SetupTest: Story = {};
export const MixedUsage: Story = { args: { entries: [entry,
  { ...entry, id: "background", actorType: "system", responsibleUserId: null, userName: null, feature: "tasks.classification", model: "typesafe/jev-1.13", provider: "openrouter", costStatus: "reported", costCents: "0.0005166", issueId: "issue-1", issueIdentifier: "PAP-21" },
  { ...entry, id: "timeout", status: "unknown", errorCode: "timeout", costStatus: "unpriced", costCents: null, inputTokens: null, outputTokens: null, durationMs: 30000 },
] } };
export const Mobile: Story = { ...MixedUsage, globals: { viewport: { value: "mobile1", isRotated: false } } };
