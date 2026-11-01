import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { TabsPreview, type TabsPreviewProps } from "../../support/design-proposals/TabsPreview";

const meta = {
  id: "design-tabs",
  title: "Design proposals/Components/Tabs",
  component: TabsPreview,
  args: { pattern: "all", width: "full" },
  argTypes: {
    pattern: { control: "select", options: ["all", "standard", "compact"] },
    width: { control: "inline-radio", options: ["full", "narrow"] },
    onWidthChange: { control: false },
  },
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Two canonical filled tab sizes: Compact (12px) and Standard (14px), based on the supplied artifact selector and Paper tab bar. TabBar retains Radix content-panel semantics; TabFilters provides exclusive collection choices with roving focus. Agents, Audit, Connectors and Artifacts compose the same shared types." } },
    paperclip: {
      capabilities: [], home: "design-proposals", status: "proposed",
      exception: "Cross-cutting tab and collection-filter comparison staged for design consolidation rather than acceptance coverage of any whole feature.",
      implementation: "mixed", boundary: "fixtures",
      notes: "Mounts canonical TabBar and TabFilters with local panels/filter state. Compact and Standard share filled selection, hover and focus styling. PageTabBar adopts Standard; CatalogSourceFilters adopts Standard radio choices; ArtifactKindFilters supports both sizes; ArtifactsToolbar explicitly uses Standard. Only Playground, Standard and Compact are exposed in this grouping. Narrow wrapping and a disabled choice are inspectable. Full page routing, authorization and queries are outside this specimen.",
    },
  },
  render: function Render(args) {
    const [, updateArgs] = useArgs<TabsPreviewProps>();
    return <TabsPreview {...args} onWidthChange={width => updateArgs({ width })} />;
  },
} satisfies Meta<typeof TabsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Playground: Story = {};
export const Standard: Story = { args: { pattern: "standard" } };
export const Compact: Story = { args: { pattern: "compact" } };
