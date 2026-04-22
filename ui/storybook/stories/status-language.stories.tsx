import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_STATUSES, ISSUE_PRIORITIES, ISSUE_STATUSES } from "@paperclipai/shared";
import { Bot, CheckCircle2, Clock3, DollarSign, FolderKanban, Inbox, MessageSquare, Users } from "lucide-react";
import { CopyText } from "@/components/CopyText";
import { EmptyState } from "@/components/EmptyState";
import { Identity } from "@/components/Identity";
import { MetricCard } from "@/components/MetricCard";
import { PriorityIcon } from "@/components/PriorityIcon";
import { QuotaBar } from "@/components/QuotaBar";
import { StatusBadge } from "@/components/StatusBadge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function Section({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: React.ReactNode;
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

function StatusLanguage() {
  const [priority, setPriority] = useState("high");

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="paperclip-story__label">Language</div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Status, priority, identity, and metrics</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
            These components carry the operational vocabulary of the board: who is acting, what state work is in,
            how urgent it is, and whether capacity or spend needs attention.
          </p>
        </section>

        <Section eyebrow="Lifecycle" title="Issue and agent statuses">
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Issue statuses</CardTitle>
                <CardDescription>Every task transition state in the V1 issue lifecycle.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {ISSUE_STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Agent statuses</CardTitle>
                <CardDescription>Runtime and governance states shown in org, sidebar, and detail surfaces.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {AGENT_STATUSES.map((status) => (
                  <StatusBadge key={status} status={status} />
                ))}
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Priority" title="Static labels and editable popover trigger">
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <div className="grid gap-3 sm:grid-cols-2">
              {ISSUE_PRIORITIES.map((item) => (
                <div key={item} className="flex items-center justify-between rounded-lg border border-border bg-background/70 p-4">
                  <PriorityIcon priority={item} showLabel />
                  <span className="font-mono text-xs text-muted-foreground">{item}</span>
                </div>
              ))}
            </div>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Editable priority</CardTitle>
                <CardDescription>Click the control to inspect the same popover used in issue rows.</CardDescription>
              </CardHeader>
              <CardContent>
                <PriorityIcon priority={priority} onChange={setPriority} showLabel />
                <div className="mt-3 text-xs text-muted-foreground">Current value: {priority}</div>
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Identity" title="Agent and user chips">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>XS</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="CodexCoder" size="xs" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Small</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="Board User" size="sm" initials="BU" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Default</CardTitle>
              </CardHeader>
              <CardContent>
                <Identity name="DesignSystemCoder" />
              </CardContent>
            </Card>
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Long label</CardTitle>
              </CardHeader>
              <CardContent className="max-w-[220px]">
                <Identity name="Senior Product Engineering Reviewer" size="lg" />
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Dashboard" title="Metrics, quota bars, empty states, and copy affordances">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard icon={Users} value={8} label="Active agents" description="3 running right now" to="/agents/active" />
              <MetricCard icon={FolderKanban} value={27} label="Open issues" description="5 in review" to="/issues" />
              <MetricCard icon={DollarSign} value="$675" label="MTD spend" description="27% of budget" to="/costs" />
              <MetricCard icon={Clock3} value="14m" label="P95 run age" description="last 24 hours" />
            </div>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Copyable identifiers</CardTitle>
                <CardDescription>Click values to exercise the status tooltip.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Issue</span>
                  <CopyText text="PAP-1641" className="font-mono">PAP-1641</CopyText>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">Run</span>
                  <CopyText text="49442f05-f1c1-45c5-88d3-1e5b871dbb8b" className="font-mono">
                    49442f05
                  </CopyText>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Quota thresholds</CardTitle>
                <CardDescription>Green, warning, and hard-stop-adjacent progress treatments.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <QuotaBar label="Company budget" percentUsed={27} leftLabel="$675 used" rightLabel="$2,500 cap" />
                <QuotaBar label="Project budget" percentUsed={86} leftLabel="$1,031 used" rightLabel="$1,200 cap" />
                <QuotaBar label="Agent budget" percentUsed={108} leftLabel="$432 used" rightLabel="$400 cap" showDeficitNotch />
              </CardContent>
            </Card>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Empty state</CardTitle>
                <CardDescription>Used when a list has no meaningful rows yet.</CardDescription>
              </CardHeader>
              <CardContent>
                <EmptyState icon={Inbox} message="No assigned work is waiting in this queue." action="Create issue" onAction={() => undefined} />
              </CardContent>
            </Card>
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Foundations/Status Language",
  component: StatusLanguage,
  parameters: {
    docs: {
      description: {
        component:
          "Status-language stories show the reusable operational labels, identity chips, metrics, and capacity indicators used throughout the board.",
      },
    },
  },
} satisfies Meta<typeof StatusLanguage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FullMatrix: Story = {};
