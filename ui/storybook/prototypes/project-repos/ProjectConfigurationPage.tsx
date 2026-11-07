import { useMemo, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { Boxes, ChevronRight, ChevronsUpDown, CircleCheck, Folder, History, Inbox, LayoutDashboard, Menu, Package, Repeat, Search, SquarePen, Star, Unplug, Users } from "lucide-react";
import { ProjectProperties } from "@/components/ProjectProperties";
import { PageTabBar } from "@/components/PageTabBar";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { storybookProjects } from "../../fixtures/paperclipData";
import { RepositoryConfigurationSection, type PrototypeProps } from "./ProjectReposPrototype";

const navigation = [
  { label: "Search", icon: Search, path: "search" },
  { label: "Dashboard", icon: LayoutDashboard, path: "dashboard" },
  { label: "Inbox", icon: Inbox, path: "inbox" },
  { heading: "Work", label: "Tasks", icon: CircleCheck, path: "issues" },
  { label: "Projects", icon: Folder, path: "projects" },
  { label: "Routines", icon: Repeat, path: "routines" },
  { label: "Artifacts", icon: Package, path: "artifacts" },
  { heading: "Org", label: "Agents", icon: Users, path: "agents" },
  { label: "Skills", icon: Boxes, path: "skills" },
  { label: "Connectors", icon: Unplug, path: "apps" },
  { label: "Audit", icon: History, path: "activity" },
];

function ReferenceSidebar() {
  return (
    <aside className="flex h-full w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground" aria-label="Bull navigation">
      <div className="flex h-14 shrink-0 items-center gap-2 px-6 text-sm font-semibold"><span className="flex size-5 items-center justify-center rounded-md border border-sidebar-border text-xs">B</span>Bull<ChevronsUpDown className="ml-auto size-3 text-muted-foreground" /></div>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-4">
        <a className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent" href="https://bull.staging.paperclip.app/BUL/issues" target="_blank" rel="noreferrer"><SquarePen className="size-4" />New Task</a>
        {navigation.map(({ label, icon: Icon, path, heading }) => <div key={label}>
          {heading && <p className="px-3 pb-2 pt-6 font-mono text-xs uppercase text-muted-foreground">{heading}</p>}
          <a href={`https://bull.staging.paperclip.app/BUL/${path}`} target="_blank" rel="noreferrer" aria-current={path === "projects" ? "page" : undefined} className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-sidebar-accent", path === "projects" && "bg-sidebar-accent")}><Icon className="size-4" />{label}</a>
        </div>)}
      </nav>
      <div className="shrink-0 px-6 py-4 text-xs text-muted-foreground">Bull workspace</div>
    </aside>
  );
}

export function ProjectConfigurationPrototype(props: PrototypeProps) {
  const client = useMemo(() => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnMount: false } } });
    c.setQueryData(queryKeys.instance.experimentalSettings, { enableManagedSandboxOnly: true, enableIsolatedWorkspaces: false, enableEnvironments: false });
    c.setQueryData(queryKeys.goals.list("company-storybook"), []);
    c.setQueryData(queryKeys.secrets.list("company-storybook"), []);
    c.setQueryData(queryKeys.secrets.userDefinitions("company-storybook"), []);
    return c;
  }, []);
  const [project, setProject] = useState<Project>(() => ({
    ...storybookProjects[0]!, id: "project-onboarding-preview", name: "Onboarding", urlKey: "onboarding",
    description: null, status: "in_progress", leadAgentId: null, goalId: null, goalIds: [], goals: [], env: null,
    archivedAt: null, targetDate: null, workspaces: [], primaryWorkspace: null,
    createdAt: new Date("2026-09-07T12:00:00Z"), updatedAt: new Date("2026-09-07T12:00:00Z"),
  }));
  const [activeTab, setActiveTab] = useState("configuration");
  const [starred, setStarred] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  return (
    <QueryClientProvider client={client}>
      <div className="flex h-dvh min-h-0 overflow-hidden bg-background">
        <div className="hidden md:block"><ReferenceSidebar /></div>
        {mobileNav && <div className="fixed inset-0 z-50 flex md:hidden"><ReferenceSidebar /><button aria-label="Close navigation" className="flex-1 bg-background/80" onClick={() => setMobileNav(false)} /></div>}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
            <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu className="size-4" /></Button>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Projects</span><ChevronRight className="size-3 text-muted-foreground" /><span className="truncate text-sm">{project.name}</span>
          </div>
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 md:p-6" aria-label="Project configuration page">
            <div className="flex flex-col gap-6">
              <header className="flex items-center gap-3"><span className="flex size-7 items-center justify-center rounded-md bg-muted"><Folder className="size-4 text-muted-foreground" /></span><h1 className="min-w-0 flex-1 truncate text-xl font-bold">{project.name}</h1><Button variant="ghost" size="icon-sm" aria-label={`Star ${project.name}`} aria-pressed={starred} onClick={() => setStarred(!starred)}><Star className={cn("size-4", starred && "fill-current")} /></Button></header>
              <Tabs value={activeTab} onValueChange={setActiveTab}><PageTabBar align="start" value={activeTab} onValueChange={setActiveTab} items={[{ value: "list", label: "Tasks" }, { value: "configuration", label: "Configuration" }, { value: "budget", label: "Budget" }]} /></Tabs>
              <div className={activeTab === "configuration" ? "max-w-4xl" : "hidden"}>
                <ProjectProperties project={project} onUpdate={(data) => setProject((previous) => ({ ...previous, ...data }))} onArchive={(archived) => setProject((previous) => ({ ...previous, archivedAt: archived ? new Date() : null }))} repositories={<RepositoryConfigurationSection {...props} />} />
              </div>
              {activeTab !== "configuration" && <div className="flex flex-col items-start gap-3 py-6"><p className="text-sm text-muted-foreground">This story previews the Configuration tab.</p><Button variant="outline" onClick={() => setActiveTab("configuration")}>Return to configuration</Button></div>}
            </div>
          </main>
        </div>
      </div>
    </QueryClientProvider>
  );
}
