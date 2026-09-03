import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SkillsContextualSidebar } from "@/components/SkillsContextualSidebar";
import { useNavigate } from "@/lib/router";

function SkillsSidebarPreview({ route }: { route: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(route, { replace: true });
  }, [navigate, route]);

  return (
    <div className="h-(--sz-520px) w-60 overflow-hidden border border-border bg-muted">
      <SkillsContextualSidebar />
    </div>
  );
}

const meta: Meta<typeof SkillsSidebarPreview> = {
  title: "Skills/Contextual navigation",
  component: SkillsSidebarPreview,
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof SkillsSidebarPreview>;

export const Installed: Story = { args: { route: "/skills" } };
export const Discover: Story = { args: { route: "/skills?tab=discover" } };
export const MySkills: Story = { args: { route: "/skills/studio" } };
