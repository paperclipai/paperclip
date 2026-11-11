import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Repeat } from "lucide-react";
import { expect, within } from "storybook/test";
import { appearanceForPalette, type Agent } from "@paperclipai/shared";
import { AgentAvatar } from "@/components/AgentAvatar";
import { buildPinnedNavigationItems } from "@/components/CoordinatorSidebar";
import { PinnedNavigationList } from "@/components/PinnedNavigationList";
import { SidebarNavItem } from "@/components/SidebarNavItem";
import { SidebarSection } from "@/components/SidebarSection";
import { StatusIcon } from "@/components/StatusIcon";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";

const agents = ([
  { id: "ceo-v2", name: "CEO v2", palette: "cherry-pop" },
  { id: "glm-coder", name: "GLMCoder", palette: "tangerine-cobalt" },
  { id: "ceo", name: "CEO", palette: "arctic-blue" },
  { id: "cto", name: "CTO", palette: "orchid-peach" },
] as const).map(({ palette, ...agent }) => ({
  ...agent, companyId: "company-storybook", urlKey: agent.id,
  appearance: appearanceForPalette(palette),
})) as Agent[];

const recentItems = [
  { title: "Align sidebar icons and labels", status: "blocked" },
  { agent: agents[0] },
  { title: "Rebuild Needs You overview", status: "blocked" },
  { agent: agents[1] },
  { agent: agents[2] },
  { title: "Fix agent blocked after retry", status: "todo" },
  { title: "Count shadcn components", status: "done" },
  { title: "Diagnose PAP-740 recovery", status: "done" },
  { title: "Status update on recent tasks", status: "done" },
  { agent: agents[3] },
];

function SidebarIconAlignment() {
  const [pins, setPins] = useState(["agent-chat:company-storybook:ceo-v2", "agent-chat:company-storybook:glm-coder", "/routines"]);
  return <TruncatedTextMarqueeProvider><aside className="coordinator-workspace coordinator-sidebar design-sidebar w-60 min-h-dvh">
    <nav className="design-sidebar-navigation" aria-label="Mixed navigation icons">
      <SidebarSection label="Pinned">
        <PinnedNavigationList items={buildPinnedNavigationItems(pins, agents, [{ to: "/routines", label: "Routines", icon: Repeat }])}
          rail={false} onReorder={setPins} onUnpin={key => setPins(previous => previous.filter(item => item !== key))} />
      </SidebarSection>
      <SidebarSection label="Recents">
        <div className="design-sidebar-recent-list">
          {recentItems.map((item, index) => <SidebarNavItem key={index} className="design-sidebar-item"
            to={item.agent ? `/chats/${item.agent.urlKey}` : `/issues/TASK-${index}`} label={item.agent?.name ?? item.title!}
            iconNode={item.agent ? <AgentAvatar agent={item.agent} size={16} /> : <StatusIcon status={item.status!} />} />)}
        </div>
      </SidebarSection>
    </nav>
  </aside></TruncatedTextMarqueeProvider>;
}

const meta = {
  id: "sidebar-icon-alignment",
  title: "Oversight and operation/Navigation, profile, and announcements/Sidebar icon alignment",
  component: SidebarIconAlignment,
  parameters: {
    layout: "fullscreen", initialEntries: ["/PAP/chats/ceo-v2"],
    paperclip: {
      capabilities: ["navigation-preferences/preferences"], status: "current", implementation: "production", boundary: "fixtures",
      notes: "Production pinned-item builder/list, nav rows, avatar and task glyphs in the Coordinator sidebar surface. Mixed icon types, active state, long labels, reorder and unpin use local fixtures; this does not prove API persistence or authorization.",
    },
  },
  play: async ({ canvasElement }) => {
    const navigation = within(canvasElement).getByRole("navigation", { name: "Mixed navigation icons" });
    const rows = within(navigation).getAllByRole("link");
    const reference = rows.find(row => row.textContent === "Routines")!.querySelector('[data-slot="sidebar-nav-icon"]')!;
    const expectedBox = reference.getBoundingClientRect();
    const expectedLabelX = reference.nextElementSibling!.getBoundingClientRect().left;
    for (const row of rows) {
      const icon = row.querySelector('[data-slot="sidebar-nav-icon"]')!;
      const box = icon.getBoundingClientRect();
      await expect(box.width).toBe(expectedBox.width);
      await expect(box.height).toBe(expectedBox.width);
      await expect(icon.nextElementSibling!.getBoundingClientRect().left).toBe(expectedLabelX);
      const glyph = icon.firstElementChild!.getBoundingClientRect();
      await expect(glyph.width).toBeLessThanOrEqual(box.width);
      await expect(glyph.height).toBeLessThanOrEqual(box.height);
    }
  },
} satisfies Meta<typeof SidebarIconAlignment>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dark: Story = { globals: { theme: "dark" } };
export const Light: Story = { globals: { theme: "light" } };
