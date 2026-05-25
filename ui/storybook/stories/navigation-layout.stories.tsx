import { useEffect, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bot,
  CircleDot,
  House,
  Inbox,
  LayoutDashboard,
  SquarePen,
  Users,
} from "lucide-react";
import { BreadcrumbBar } from "@/components/BreadcrumbBar";
import { CommandPalette } from "@/components/CommandPalette";
import { CompanySwitcher } from "@/components/CompanySwitcher";
import { KeyboardShortcutsCheatsheetContent } from "@/components/KeyboardShortcutsCheatsheet";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { PageTabBar } from "@/components/PageTabBar";
import { Sidebar } from "@/components/Sidebar";
import { SidebarAccountMenu } from "@/components/SidebarAccountMenu";
import { SidebarCompanyMenu } from "@/components/SidebarCompanyMenu";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Tabs } from "@/components/ui/tabs";
import { BreadcrumbProvider, useBreadcrumbs, type Breadcrumb } from "@/context/BreadcrumbContext";
import { useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import {
  storybookAgents,
  storybookIssues,
  storybookProjects,
  storybookSidebarBadges,
} from "../fixtures/paperclipData";

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="paperclip-story__frame overflow-hidden">
      <div className="border-b border-border px-5 py-4">
        <div className="paperclip-story__label">{eyebrow}</div>
        <h2 className="mt-1 text-xl font-semibold">{title}</h2>
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

function RouteSetter({ to }: { to: string }) {
  const navigate = useNavigate();

  useEffect(() => {
    navigate(to, { replace: true });
  }, [navigate, to]);

  return null;
}

function SidebarShell({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className="h-[520px] overflow-hidden border border-border bg-background">
      <div className="flex h-full min-h-0">
        <div className={cn("overflow-hidden transition-[width]", collapsed ? "w-0" : "w-60")}>
          <Sidebar />
        </div>
      </div>
    </div>
  );
}

function BreadcrumbScenario({ breadcrumbs }: { breadcrumbs: Breadcrumb[] }) {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs(breadcrumbs);
  }, [breadcrumbs, setBreadcrumbs]);

  return (
    <div className="overflow-hidden border border-border bg-background">
      <BreadcrumbBar />
    </div>
  );
}

function BreadcrumbSnapshot({ breadcrumbs }: { breadcrumbs: Breadcrumb[] }) {
  return (
    <BreadcrumbProvider>
      <BreadcrumbScenario breadcrumbs={breadcrumbs} />
    </BreadcrumbProvider>
  );
}

const tabItems = [
  { value: "overview", label: "Overview" },
  { value: "issues", label: "Issues" },
  { value: "runs", label: "Runs" },
  { value: "approvals", label: "Approvals" },
  { value: "budget", label: "Budget" },
  { value: "activity", label: "Activity" },
  { value: "settings", label: "Settings" },
  { value: "history", label: "History" },
];

const mobileNavItems = [
  { label: "Home", icon: House },
  { label: "Issues", icon: CircleDot },
  { label: "Create", icon: SquarePen },
  { label: "Agents", icon: Users },
  { label: "Inbox", icon: Inbox, badge: storybookSidebarBadges.inbox },
];

function MobileBottomNavActiveStateMatrix() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {mobileNavItems.map((activeItem) => (
        <div key={activeItem.label} className="overflow-hidden border border-border bg-background">
          <div className="grid h-16 grid-cols-5 px-1">
            {mobileNavItems.map((item) => {
              const Icon = item.icon;
              const active = item.label === activeItem.label;
              return (
                <div
                  key={item.label}
                  className={cn(
                    "relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-md text-[10px] font-medium",
                    active ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <span className="relative">
                    <Icon className={cn("h-[18px] w-[18px]", active && "stroke-[2.3]")} />
                    {item.badge ? (
                      <span className="absolute -right-2 -top-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none text-primary-foreground">
                        {item.badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="truncate">{item.label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function CommandResultsSurface() {
  return (
    <Command className="rounded-none border border-border">
      <CommandInput value="story" readOnly placeholder="Search issues, agents, projects..." />
      <CommandList className="max-h-none">
        <CommandGroup heading="Actions">
          <CommandItem>
            <SquarePen className="mr-2 h-4 w-4" />
            Create new issue
            <span className="ml-auto text-xs text-muted-foreground">C</span>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Issues">
          {storybookIssues.slice(0, 2).map((issue) => (
            <CommandItem key={issue.id}>
              <CircleDot className="mr-2 h-4 w-4" />
              <span className="mr-2 font-mono text-xs text-muted-foreground">{issue.identifier}</span>
              <span className="flex-1 truncate">{issue.title}</span>
              <StatusBadge status={issue.status} />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Agents">
          {storybookAgents.map((agent) => (
            <CommandItem key={agent.id}>
              <Bot className="mr-2 h-4 w-4" />
              {agent.name}
              <span className="ml-2 text-xs text-muted-foreground">{agent.role}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Projects">
          {storybookProjects.map((project) => (
            <CommandItem key={project.id}>
              <LayoutDashboard className="mr-2 h-4 w-4" />
              {project.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function CommandEmptySurface() {
  return (
    <Command className="rounded-none border border-border">
      <CommandInput value="no matching command" readOnly placeholder="Search issues, agents, projects..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
      </CommandList>
    </Command>
  );
}

function NavigationLayoutStories() {
  return (
    <div className="paperclip-story">
      <RouteSetter to="/PAP/projects/board-ui/issues" />
      <main className="paperclip-story__inner max-w-[1320px] space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="paperclip-story__label">Navigation and layout</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">Sidebar, command, tabs, and mobile chrome</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                Fixture-backed navigation states for the board shell: company switching, dense work navigation,
                breadcrumbs, command discovery, and mobile entry points.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">fixture backed</Badge>
              <Badge variant="outline">company scoped</Badge>
              <Badge variant="outline">responsive chrome</Badge>
            </div>
          </div>
        </section>

        <Section eyebrow="Sidebar" title="Expanded and collapsed shell states">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_220px]">
            <SidebarShell />
            <SidebarShell collapsed />
          </div>
        </Section>

        <Section eyebrow="Menus" title="Account, company, and switcher menus in open state">
          <div className="grid gap-5 xl:grid-cols-3">
            <div className="relative h-[440px] overflow-hidden border border-border bg-background">
              <div className="absolute bottom-0 left-0 w-72">
                <SidebarAccountMenu
                  deploymentMode="authenticated"
                  instanceSettingsTarget="/instance/settings/general"
                  open
                  onOpenChange={() => undefined}
                  version="0.3.1"
                />
              </div>
            </div>

            <div className="h-[260px] overflow-hidden border border-border bg-background p-3">
              <SidebarCompanyMenu open onOpenChange={() => undefined} />
            </div>

            <div className="h-[320px] overflow-hidden border border-border bg-background p-4">
              <CompanySwitcher open onOpenChange={() => undefined} />
            </div>
          </div>
        </Section>

        <Section eyebrow="Breadcrumbs" title="Home, project issue, and agent run depth levels">
          <div className="grid gap-4">
            <BreadcrumbSnapshot breadcrumbs={[{ label: "Dashboard", href: "/dashboard" }]} />
            <BreadcrumbSnapshot
              breadcrumbs={[
                { label: "Projects", href: "/projects" },
                { label: "Board UI", href: "/projects/board-ui/issues" },
                { label: "PAP-1641" },
              ]}
            />
            <BreadcrumbSnapshot
              breadcrumbs={[
                { label: "Agents", href: "/agents" },
                { label: "CodexCoder", href: "/agents/codexcoder" },
                { label: "Run run-storybook" },
              ]}
            />
          </div>
        </Section>

        <Section eyebrow="Page tabs" title="Active and overflow tab bars">
          <div className="space-y-5">
            <Tabs value="issues" className="overflow-x-auto">
              <PageTabBar items={tabItems.slice(0, 4)} value="issues" align="start" />
            </Tabs>
            <Tabs value="activity" className="overflow-x-auto">
              <PageTabBar items={tabItems} value="activity" align="start" />
            </Tabs>
          </div>
        </Section>

        <Section eyebrow="Mobile bottom nav" title="Actual mobile bar and all active item states">
          <div className="space-y-5">
            <div className="relative h-24 max-w-sm overflow-hidden border border-border bg-background [&>nav]:!absolute [&>nav]:!bottom-0 [&>nav]:!left-0 [&>nav]:!right-0 [&>nav]:!z-0 [&>nav]:!block">
              <MobileBottomNav visible />
            </div>
            <MobileBottomNavActiveStateMatrix />
          </div>
        </Section>

        <Section eyebrow="Command palette" title="Open command results and empty state">
          <CommandPalette />
          <div className="grid gap-5 xl:grid-cols-2">
            <CommandResultsSurface />
            <CommandEmptySurface />
          </div>
        </Section>

        <Section eyebrow="Keyboard shortcuts" title="Rendered shortcuts cheatsheet">
          <div className="max-w-md overflow-hidden border border-border bg-background">
            <div className="px-5 pb-3 pt-5">
              <h3 className="text-base font-semibold">Keyboard shortcuts</h3>
            </div>
            <KeyboardShortcutsCheatsheetContent />
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Navigation & Layout",
  component: NavigationLayoutStories,
  parameters: {
    docs: {
      description: {
        component:
          "Navigation and layout stories cover the board shell components that orient operators across companies, work surfaces, command search, breadcrumbs, tabs, and mobile navigation.",
      },
    },
  },
} satisfies Meta<typeof NavigationLayoutStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BoardChromeMatrix: Story = {};
