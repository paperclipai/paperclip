import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useNavigate } from "@/lib/router";
import { Inbox } from "@/pages/Inbox";
import { Issues } from "@/pages/Issues";

function CollectionPagePreview({ route }: { route: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(route, { replace: true });
  }, [navigate, route]);

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      {route.startsWith("/inbox") ? <Inbox /> : <Issues />}
    </div>
  );
}

const meta = {
  title: "Pages/Inbox and Tasks collections",
  component: CollectionPagePreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Live page previews for the separate Inbox and Tasks routes. Use these stories alongside the worktree app to compare their shared toolbar geometry and canonical task-row presentation without collapsing their query semantics.",
      },
    },
  },
} satisfies Meta<typeof CollectionPagePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InboxMine: Story = {
  args: { route: "/inbox/mine" },
};

export const InboxBlocked: Story = {
  args: { route: "/inbox/blocked" },
};

export const Tasks: Story = {
  args: { route: "/issues" },
};

export const InboxMobile: Story = {
  args: { route: "/inbox/mine" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
