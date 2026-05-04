import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  BookOpen,
  Bot,
  CheckCircle2,
  FlaskConical,
  FolderKanban,
  FormInput,
  Layers3,
  LayoutDashboard,
  ListTodo,
  MessageSquare,
  PanelLeft,
  Route,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const storyGroups = [
  {
    title: "Foundations",
    icon: Layers3,
    stories: "Buttons, badges, form controls, tabs, cards, dialogs, overlays",
    why: "Baseline tokens and primitives before product components add state.",
  },
  {
    title: "Control Plane Surfaces",
    icon: ShieldCheck,
    stories: "Issue rows, approvals, budget cards, activity rows, metrics",
    why: "The V1 board UI depends on these dense operational patterns staying legible.",
  },
  {
    title: "UX Labs",
    icon: FlaskConical,
    stories: "Issue chat, run transcripts, invite/access flows",
    why: "The old `/tests/ux/*` pages are fixture-backed Storybook stories now.",
  },
  {
    title: "Navigation & Layout",
    icon: PanelLeft,
    stories: "Sidebar, breadcrumbs, command palette, company rail, mobile nav",
    why: "Navigation chrome frames every board interaction and needs mobile parity.",
  },
  {
    title: "Agent Management",
    icon: Bot,
    stories: "Agent properties, config forms, icon picker, action buttons",
    why: "Agent lifecycle is the primary governance surface for operators.",
  },
  {
    title: "Issue Management",
    icon: ListTodo,
    stories: "Issue lists, filters, properties, documents, run ledger, workspace cards",
    why: "Issues are the core work unit — every view state matters for scan speed.",
  },
  {
    title: "Forms & Editors",
    icon: FormInput,
    stories: "Markdown editor, JSON schema forms, env vars, schedule editor, pickers",
    why: "Rich editors need isolated review for empty, filled, and validation states.",
  },
  {
    title: "Budget & Finance",
    icon: Wallet,
    stories: "Incident cards, provider quotas, biller spend, subscription panels",
    why: "Financial controls are safety-critical and need threshold state coverage.",
  },
  {
    title: "Dialogs & Modals",
    icon: LayoutDashboard,
    stories: "New issue/agent/goal/project dialogs, diff modal, image gallery",
    why: "Dialogs interrupt flow — they must be scannable and self-explanatory.",
  },
  {
    title: "Projects & Goals",
    icon: FolderKanban,
    stories: "Project properties, workspace cards, goal trees, runtime controls",
    why: "Hierarchical views (goals, projects, workspaces) need expand/collapse coverage.",
  },
  {
    title: "Chat & Comments",
    icon: MessageSquare,
    stories: "Comment threads, run chat, issue chat with timeline events",
    why: "Threaded conversations mix agent/user/system authors and need density review.",
  },
];

const coverageRows = [
  ["System primitives", "Covered", "State matrix across size, variant, disabled, icon, and overlay behavior"],
  ["Status language", "Covered", "Issue/agent lifecycle badges, priorities, quota thresholds, and empty states"],
  ["Task surfaces", "Covered", "Inbox-style rows with unread, selected, archive, and trailing metadata states"],
  ["Governance", "Covered", "Pending, revision-requested, approved, and budget-specific approval payloads"],
  ["Budget controls", "Covered", "Healthy, warning, hard-stop, compact, plain, and editable card variants"],
  ["Execution UX", "Covered", "Run transcript detail, live widget, dashboard card, streaming and settled views"],
  ["Invite UX", "Covered", "Fixture-backed access roles, invite landing, pending, accepted, expired, and error states"],
  ["Navigation & layout", "Planned", "Sidebar, breadcrumbs, command palette, company rail, mobile nav"],
  ["Agent management", "Planned", "Agent properties, config forms, icon picker, action buttons, active panel"],
  ["Issue management", "Planned", "Issue lists, filters, properties, documents, run ledger, workspace cards"],
  ["Forms & editors", "Planned", "Markdown editor, JSON schema, env vars, schedule editor, pickers"],
  ["Budget & finance", "Planned", "Incident cards, provider quotas, biller spend, subscription panels"],
  ["Dialogs & modals", "Planned", "New issue/agent/goal/project dialogs, diff modal, image gallery"],
  ["Projects & goals", "Planned", "Project properties, workspace cards, goal trees, runtime controls"],
  ["Chat & comments", "Covered", "Comment threads, run chat, issue chat with timeline events"],
  ["Data viz & misc", "Planned", "Activity charts, kanban, filter bar, live widget, onboarding, skeletons"],
  ["Full app pages", "Deferred", "API-driven route stories after page data loaders can be fixture-injected"],
];

function StorybookGuide() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-8">
        <section className="paperclip-story__frame overflow-hidden p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="max-w-3xl">
              <div className="paperclip-story__label flex items-center gap-2">
                <BookOpen className="h-4 w-4" />
                Paperclip Storybook
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Board UI stories for real control-plane states
              </h1>
              <p className="mt-4 text-sm leading-6 text-muted-foreground sm:text-base">
                This Storybook is organized as a review workspace for Paperclip's operator UI: primitives first,
                product surfaces second, and the former UX test routes as isolated fixture-backed stories.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">React 19</Badge>
              <Badge variant="outline">Vite</Badge>
              <Badge variant="outline">Tailwind 4</Badge>
              <Badge variant="outline">Fixture backed</Badge>
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {storyGroups.map((group) => {
            const Icon = group.icon;
            return (
              <Card key={group.title} className="paperclip-story__frame shadow-none">
                <CardHeader>
                  <div className="flex h-10 w-10 items-center justify-center border border-border bg-background">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <CardTitle>{group.title}</CardTitle>
                  <CardDescription>{group.stories}</CardDescription>
                </CardHeader>
                <CardContent className="text-sm leading-6 text-muted-foreground">
                  {group.why}
                </CardContent>
              </Card>
            );
          })}
        </section>

        <section className="paperclip-story__frame overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="paperclip-story__label flex items-center gap-2">
              <Route className="h-4 w-4" />
              Coverage Map
            </div>
          </div>
          <div className="divide-y divide-border">
            {coverageRows.map(([area, status, detail]) => (
              <div key={area} className="grid gap-3 px-5 py-4 text-sm sm:grid-cols-[180px_120px_minmax(0,1fr)]">
                <div className="font-medium">{area}</div>
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-xs text-muted-foreground">
                    {status === "Covered" ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : null}
                    {status === "Planned" ? <Route className="h-3 w-3 text-cyan-500" /> : null}
                    {status}
                  </span>
                </div>
                <div className="text-muted-foreground">{detail}</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

const meta = {
  title: "Overview/Storybook Guide",
  component: StorybookGuide,
  parameters: {
    docs: {
      description: {
        component:
          "The overview story explains the local organization and the coverage contract for Paperclip's Storybook.",
      },
    },
  },
} satisfies Meta<typeof StorybookGuide>;

export default meta;

type Story = StoryObj<typeof meta>;

export const CoverageGuide: Story = {};
