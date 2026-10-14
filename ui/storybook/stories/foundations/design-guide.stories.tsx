import type { Meta, StoryObj } from "@storybook/react-vite";
import { DesignGuide } from "@/pages/DesignGuide";
const meta = { id: "design-system-design-guide", title: "Foundations/Design guide", component: DesignGuide, parameters: { layout: "fullscreen", paperclip: { capabilities: ["chat-channels/providers", "chat-channels/conversation", "chat-channels/lifecycle"], home: "foundations", exception: "Cross-feature visual reference gallery; keep the shared design guide in Foundations.", status: "current", implementation: "production", boundary: "fixtures", notes: "Renders the shipped DesignGuide with example voice controls and forms. This is a component reference, not a live setup, task or call journey." } } } satisfies Meta<typeof DesignGuide>;
export default meta;
export const Showcase: StoryObj<typeof meta> = {};
