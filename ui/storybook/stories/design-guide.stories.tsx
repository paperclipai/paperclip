import type { Meta, StoryObj } from "@storybook/react-vite";
import { DesignGuide } from "@/pages/DesignGuide";
const meta = { title: "Design system/Design guide", component: DesignGuide, parameters: { layout: "fullscreen" } } satisfies Meta<typeof DesignGuide>;
export default meta;
export const Showcase: StoryObj<typeof meta> = {};
