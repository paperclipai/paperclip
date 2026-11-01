import type { Meta, StoryObj } from "@storybook/react-vite";
import { TypographyPreview } from "../../support/design-proposals/TypographyPreview";
import { ConversationTypeSpec } from "../../support/design-proposals/ConversationTypeSpec";
import { ConversationTypographyPreview } from "../../support/design-proposals/ConversationTypographyPreview";

const meta = {
  id: "design-foundations-typography",
  title: "Design proposals/Foundations/Typography",
  component: TypographyPreview,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "Proposed type ramp and source-derived typography roles for Design Proposals and the local design sandbox. Live measurements distinguish current CSS behavior from proposed guidance. Includes shared TaskList, MetricCard and MarkdownBody examples; the shared proposal typography also applies to the opt-in sandbox." } },
    paperclip: {
      capabilities: [],
      home: "design-proposals",
      status: "proposed",
      exception: "Cross-cutting typography foundation for Design Proposals and its sandbox integration; not a production feature acceptance story.",
      implementation: "guide",
      boundary: "fixtures",
      notes: "Documents the proposed nine-step 10–30px ramp, Inter/Paper Mono families, normal/semibold weights, emphasis, overflow and source-derived roles. Recipe specimens show existing classes/tokens; integrated TaskList, MetricCard and MarkdownBody samples mount real shared components with synthetic text. Conversation styles mounts DesignSandboxTaskThread directly with its complete 72-state fixture catalog, grouped preview selector, replay, activity disclosures and local composer actions. Optional typography measurements inspect the rendered composition on demand. Browser-computed metrics are local measurements, not a production-wide runtime audit. Existing out-of-ramp Markdown, metadata sizes and muted headings remain explicit review items. Navigation and streamlined property sections share one label recipe; previous micro usages are xs. Dark desktop reference, with responsive behavior noted; no provider actions or ordinary-theme adoption. Conversation regions use shared 14px/20px body and 12px/16px metadata recipes, with muted supporting text, contrasting human bubbles and foreground final replies.",
    },
  },
} satisfies Meta<typeof TypographyPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TypeSpecification: Story = { name: "Type specification" };
export const ConversationStyles: Story = {
  name: "Conversation styles",
  render: () => <ConversationTypographyPreview />,
  parameters: {
    initialEntries: ["/DES/issues/DES-7?threadPreview=all"],
    docs: { description: { story: "The exact DesignSandboxTaskThread composition used by the sandbox IssueDetail page, with all 72 canonical synthetic states and the same grouped selector, replay, transcript/native renderer paths, history, activity disclosures, requests and composer. Defaults to All states. Optional measurements inspect its rendered typography; refresh after changing state or opening disclosures. Saved backend conversation data is not loaded in Storybook. Preview actions remain local. Production renderer reuse does not verify a deployed production version, and the shared proposal conversation typography is applied." } },
  },
};

export const ConversationTypeSpecification: Story = {
  name: "Conversation type spec",
  render: () => <ConversationTypeSpec />,
  parameters: {
    initialEntries: ["/DES/issues/DES-7?threadPreview=all"],
    docs: { description: { story: "A measured conversation typography specification in the same layout as Type specification. Mounts the complete shared 72-state sandbox preview and inventories currently rendered text into size, family, weight and surface/recipe rows. Includes search, surface filtering, shared-metric consolidation candidates, source classes, example-state links and explicit inventory refresh after disclosures or state changes. Isolated specimens copy browser-computed type properties; the real composition remains in context. Closed content, placeholders and absent Markdown structures are not counted. Measures the consolidated proposal conversation typography; no backend action is applied." } },
  },
};

export const ConversationPlayback: Story = {
  name: "Conversation playback",
  render: () => <ConversationTypographyPreview playback />,
  parameters: {
    docs: { description: { story: "Watch two exchanges in one continuous synthetic conversation using the shared sandbox playback controller and production transcript renderers. Play, pause, resume and replay are local. Thinking, commentary, tools and a final answer lead into a follow-up with queuing, planning, clarification, permission, a failed test and retry, a file preview, usage and another final answer. Demo answers and permission receipts advance automatically; request controls are disabled. New words fade over 320ms; running tool text shimmers white and final-channel text streams in foreground. Completed tools return to muted metadata. Reduced motion suppresses decorative motion. No provider, agent, command or backend mutation is triggered. The separate Conversation styles and type spec stories retain all 72 inspectable fixtures." } },
  },
};
