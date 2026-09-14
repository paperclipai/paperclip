import type { Meta, StoryObj } from "@storybook/react-vite";
import pages from "../fixtures/runtimePreviewPages.json";

function PreviewPage({ state = "starting" }: { state?: keyof typeof pages }) {
  return <iframe className="h-screen w-full border-0" title="Standalone preview page" srcDoc={pages[state]} sandbox="" />;
}
const meta = {
  title: "Runtime Services/05 Preview gateway pages",
  component: PreviewPage,
  parameters: { layout: "fullscreen", docs: { description: { component: "Full standalone pages produced by the production server previewPage renderer. Regenerate with ui/storybook/scripts/generate-runtime-preview-pages.mjs. The iframe disables navigation and scripts for review, so polling and authentication are not exercised. These pages intentionally have no board sidebar: they appear at the app’s separate preview origin." } } },
} satisfies Meta<typeof PreviewPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Starting: Story = { args: { state: "starting" } };
export const Sleeping: Story = { args: { state: "sleeping" } };
export const Stopped: Story = { args: { state: "stopped" } };
export const NeedsAttention: Story = { args: { state: "failed" } };
export const Unavailable: Story = { args: { state: "unavailable" } };
export const NotFound: Story = { args: { state: "notFound" } };
export const AccessRequired: Story = { args: { state: "accessRequired" } };
export const SignIn: Story = { args: { state: "signIn" } };
export const ExpiredOrRevokedShare: Story = { args: { state: "shareUnavailable" } };
