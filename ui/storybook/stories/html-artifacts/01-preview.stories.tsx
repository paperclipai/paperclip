import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextAttachmentPreview } from "@/components/task-side-panel/TaskAttachmentPanel";
import { reportHtml, securityHtml } from "./fixtures";

function Preview({ html = reportHtml, title = "repository-usage.html", width = 800 }: { html?: string; title?: string; width?: number }) {
  return <main className="min-h-screen bg-background p-4 text-foreground">
    <section className="mx-auto flex h-(--sz-640px) max-w-full flex-col overflow-hidden rounded-lg border border-border" style={{ width }}>
      <TextAttachmentPreview key={title} title={title} text={html} markdown={false} html downloadUrl={`data:text/html;charset=utf-8,${encodeURIComponent(html)}`} />
    </section>
  </main>;
}

const meta = {
  title: "HTML artifacts/01 Preview",
  component: Preview,
  args: { html: reportHtml, title: "repository-usage.html", width: 800 },
  parameters: { layout: "fullscreen", docs: { description: { component: "Production attachment viewer. Inline CSS and JavaScript run in an opaque-origin sandbox. Remote dependencies and API requests are blocked. The original file is available through Download or Raw." }, story: { inline: false } } },
} satisfies Meta<typeof Preview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const InteractiveReport: Story = {};
export const SecurityChecks: Story = { args: { html: securityHtml, title: "isolation-checks.html" } };
export const Empty: Story = { args: { html: "", title: "empty.html" } };
export const Mobile: Story = { args: { width: 360 }, globals: { viewport: { value: "mobile", isRotated: false } } };
export const Light: Story = { globals: { theme: "light" } };
