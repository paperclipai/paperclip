import type { Meta, StoryObj } from "@storybook/react-vite";
import { useArgs } from "storybook/preview-api";
import { ButtonsPlayground, type ButtonsPlaygroundProps } from "../../support/design-proposals/ButtonsPlayground";
import { buttonSizes, buttonStates, buttonSurfaces, buttonVariants, defaultButtonSettings } from "../../support/design-proposals/ButtonSamples";

const meta = {
  id: "design-buttons",
  title: "Design proposals/Components/Buttons",
  component: ButtonsPlayground,
  args: { ...defaultButtonSettings },
  argTypes: {
    label: { control: "text" },
    variant: { control: "select", options: Object.keys(buttonVariants) },
    size: { control: "select", options: Object.keys(buttonSizes) },
    icon: { control: "inline-radio", options: ["none", "leading", "trailing"] },
    state: { control: "select", options: Object.keys(buttonStates) },
    surface: { control: "select", options: Object.keys(buttonSurfaces) },
    onSettingsChange: { control: false },
  },
  parameters: {
    layout: "fullscreen",
    initialEntries: ["/PAP/issues"],
    docs: { story: { inline: false }, description: { component: "Sandbox button styling workbench. Visible controls and Storybook args select label, style, measured size, icon placement, default/hover/keyboard-focus/pressed/disabled/loading state and semantic surface. All examples use the same proposed theme as the local design sandbox. Specimens report computed pixel dimensions, typography, padding, radius, icon size and colors. Forced states derive from compiled component CSS and remain preview-only. Contextual controls use real shared components with local fixture actions. No production comparison or repository-wide usage counts are shown." } },
    paperclip: {
      capabilities: ["developer-labs/design"],
      home: "design-proposals",
      status: "proposed",
      exception: "Button styling workbench for the proposed design system used by the local sandbox; not a production feature acceptance story.",
      implementation: "mixed",
      boundary: "fixtures",
      notes: "Uses shared Button variants/sizes and sandbox task toolbar/list/sidebar, side-panel, agent action, conversation feedback, favorite, file display, switch, task status, attachment and relation-expansion controls. All samples inherit proposal foundations, including portaled menus. The workbench layout and controls are preview scaffolding. Mutation callbacks use local fixtures; no agents run or uploads persist. Legacy-only sidebar/filter/archive examples, feature-gated priority, setup-prompt catalog, isolated production iframe and repository-wide usage audit are excluded. Does not enumerate every page-specific override or establish backend acceptance.",
    },
  },
  render: function Render(args) {
    const [, updateArgs] = useArgs<ButtonsPlaygroundProps>();
    return <ButtonsPlayground {...args} onSettingsChange={updateArgs} />;
  },
} satisfies Meta<typeof ButtonsPlayground>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};
