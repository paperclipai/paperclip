import type { Meta, StoryObj } from "@storybook/react-vite";
import { ManagedAggregatorAccounts } from "../prototypes/ManagedAggregatorAccounts";
const meta = { title: "Apps/Managed accounts", component: ManagedAggregatorAccounts, parameters: { layout: "fullscreen", docs: { description: { component: "Production Apps page using production API routes and a disposable PostgreSQL database. Upstream Arcade, Composio and Executor responses are fixtures. Start tests/aggregator-accounts/test-drive.ts, then use the upstream controls and each gateway’s Refresh action." } } } } satisfies Meta<typeof ManagedAggregatorAccounts>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FullStackTestDrive: Story = {};
