import type { Meta, StoryObj } from "@storybook/react-vite";
import { UploadPreview } from "../../../support/artifact-upload/UploadPreview";
import { showFileDrag } from "../../../support/artifact-upload/fixtures";

const meta = {
  id: "artifact-upload-01-artifacts-pane",
  title: "Tasks and conversations/Documents, attachments, and work products/Artifact upload/01 Artifacts pane", component: UploadPreview,
  parameters: { layout: "fullscreen", docs: { description: { component: "The upload icon sits in the tab header without text or a background. The entire Artifacts panel, including its header, padding, existing cards and empty space, accepts files. Drag-over stories enter through the actual header drag handler and highlight the complete visible panel, including after scrolling. Use the upload icon for one or several files. Markdown becomes a document; other files use artifact cards. Uploads are simulated in memory and reset when the story reloads. The Uploading story holds its example pending; Retry completes the sample CSV upload. No task or execution state changes." }, story: { inline: false } },
    paperclip: {
      "capabilities": [
        "documents-artifacts/attachments"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  argTypes: { state: { control: "select", options: ["empty", "populated", "uploading", "error", "long"] } },
  render: (args, context) => <div className="h-screen max-w-lg border-r border-border"><UploadPreview key={`${context.id}-${args.state}`} {...args} /></div>,
} satisfies Meta<typeof UploadPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = { args: { state: "empty" } };
export const Populated: Story = { args: { state: "populated" } };
export const Uploading: Story = { args: { state: "uploading" } };
export const RetryUpload: Story = { args: { state: "error" } };
export const LongReference: Story = { args: { state: "long" } };
export const DragOverEmptyPanel: Story = { args: { state: "empty" }, play: ({ canvasElement }) => showFileDrag(canvasElement) };
export const DragOverExistingArtifacts: Story = { args: { state: "populated" }, play: ({ canvasElement }) => showFileDrag(canvasElement) };
export const DragOverScrolledArtifacts: Story = { args: { state: "long" }, play: ({ canvasElement }) => showFileDrag(canvasElement, true) };
export const Mobile: Story = { args: { state: "populated" }, globals: { viewport: { value: "mobile", isRotated: false } } };
export const MobileError: Story = { args: { state: "error" }, globals: { viewport: { value: "mobile", isRotated: false } } };
