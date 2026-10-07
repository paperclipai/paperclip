import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextAttachmentPreview } from "@/components/task-side-panel/TaskAttachmentPanel";

const meta: Meta<typeof TextAttachmentPreview> = {
  title: "Components/CSV File Tab",
  component: TextAttachmentPreview,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div className="h-screen bg-background text-foreground"><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof TextAttachmentPreview>;
export const RevenueExport: Story = {
  args: {
    title: "monthly-revenue.csv",
    markdown: false,
    csv: true,
    downloadUrl: "data:text/csv,Month%2CRevenue%0AOctober%2C12800",
    text: 'Month,Customer,Plan,Revenue,Status,Notes\nOctober,"Acme, Inc.",Enterprise,12800,Active,"Expanded to 40 seats"\nOctober,Northstar Studio,Pro,2400,Active,"Annual renewal"\nOctober,Atlas Labs,Enterprise,9600,Active,"Includes onboarding"\nOctober,Juniper Design,Starter,480,Trial,"Review on Friday"\nSeptember,"Acme, Inc.",Enterprise,11200,Active,"32 seats"\nSeptember,Northstar Studio,Pro,2400,Active,"Annual renewal"\nSeptember,Atlas Labs,Pro,4800,Active,"Upgrade scheduled"\nSeptember,Juniper Design,Starter,480,Trial,"First month"',
  },
};
export const Empty: Story = { args: { ...RevenueExport.args, text: "" } };
export const Invalid: Story = { args: { ...RevenueExport.args, text: 'Name,Notes\nSam,"unfinished' } };
