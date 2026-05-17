import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertTriangle, CheckCircle2, Clock3, Eye, GitPullRequest, Inbox, WalletCards } from "lucide-react";
import { ActivityRow } from "@/components/ActivityRow";
import { ApprovalCard } from "@/components/ApprovalCard";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";
import { Identity } from "@/components/Identity";
import { IssueRow } from "@/components/IssueRow";
import { PriorityIcon } from "@/components/PriorityIcon";
import { StatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  storybookActivityEvents,
  storybookAgentMap,
  storybookAgents,
  storybookApprovals,
  storybookBudgetSummaries,
  storybookEntityNameMap,
  storybookEntityTitleMap,
  storybookIssues,
} from "../fixtures/paperclipData";

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

function ControlPlaneSurfaces() {
  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <div className="paperclip-story__label">Product surfaces</div>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight">Control-plane boards and cards</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground">
                Paperclip's common board surfaces are deliberately dense: task rows, approvals, budget policy cards,
                and audit rows all need to scan quickly while preserving enough state to make autonomous work governable.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">company scoped</Badge>
              <Badge variant="outline">single assignee</Badge>
              <Badge variant="outline">auditable</Badge>
            </div>
          </div>
        </section>

        <Section eyebrow="Issues" title="Inbox/task rows across selection and unread states">
          <div className="overflow-hidden rounded-xl border border-border bg-background/70">
            {storybookIssues.map((issue, index) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                selected={index === 0}
                unreadState={index === 0 ? "visible" : index === 1 ? "hidden" : null}
                onMarkRead={() => undefined}
                onArchive={() => undefined}
                desktopTrailing={
                  <span className="hidden items-center gap-2 lg:inline-flex">
                    <PriorityIcon priority={issue.priority} showLabel />
                    {issue.assigneeAgentId ? (
                      <Identity name={storybookAgentMap.get(issue.assigneeAgentId)?.name ?? "Unassigned"} size="sm" />
                    ) : (
                      <span className="text-xs text-muted-foreground">Board</span>
                    )}
                  </span>
                }
                trailingMeta={index === 0 ? "3m ago" : index === 1 ? "blocked by budget" : "review requested"}
                mobileMeta={<StatusBadge status={issue.status} />}
                titleSuffix={
                  index === 0 ? (
                    <span className="ml-2 inline-flex align-middle">
                      <Badge variant="secondary">Storybook</Badge>
                    </span>
                  ) : null
                }
              />
            ))}
          </div>
        </Section>

        <Section eyebrow="Approvals" title="Governance cards for pending, revision, and approved decisions">
          <div className="grid gap-5 xl:grid-cols-3">
            {storybookApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                requesterAgent={approval.requestedByAgentId ? storybookAgentMap.get(approval.requestedByAgentId) ?? null : null}
                onApprove={approval.status === "pending" ? () => undefined : undefined}
                onReject={approval.status === "pending" ? () => undefined : undefined}
                detailLink={`/approvals/${approval.id}`}
              />
            ))}
          </div>
        </Section>

        <Section eyebrow="Budgets" title="Healthy, warning, and hard-stop budget policy cards">
          <div className="grid gap-5 xl:grid-cols-3">
            {storybookBudgetSummaries.map((summary, index) => (
              <BudgetPolicyCard
                key={summary.policyId}
                summary={summary}
                compact={index === 0}
                onSave={index === 1 ? () => undefined : undefined}
              />
            ))}
          </div>
          <div className="mt-5 rounded-xl border border-border bg-background/70 p-5">
            <BudgetPolicyCard
              summary={storybookBudgetSummaries[2]!}
              variant="plain"
              onSave={() => undefined}
            />
          </div>
        </Section>

        <Section eyebrow="Activity" title="Audit rows with agent, user, and system actors">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="overflow-hidden rounded-xl border border-border bg-background/70">
              {storybookActivityEvents.map((event) => (
                <ActivityRow
                  key={event.id}
                  event={event}
                  agentMap={storybookAgentMap}
                  entityNameMap={storybookEntityNameMap}
                  entityTitleMap={storybookEntityTitleMap}
                />
              ))}
            </div>

            <Card className="shadow-none">
              <CardHeader>
                <CardTitle>Run summary card language</CardTitle>
                <CardDescription>Compact status treatments used around live work.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {[
                  { icon: Clock3, label: "Running", detail: "CodexCoder is editing Storybook fixtures", tone: "text-cyan-600" },
                  { icon: GitPullRequest, label: "Review", detail: "QAChecker requested browser screenshots", tone: "text-amber-600" },
                  { icon: CheckCircle2, label: "Verified", detail: "Vitest and static Storybook build passed", tone: "text-emerald-600" },
                  { icon: AlertTriangle, label: "Blocked", detail: "Budget hard stop paused a run", tone: "text-red-600" },
                ].map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.label} className="flex items-start gap-3 rounded-lg border border-border bg-background/70 p-3">
                      <Icon className={`mt-0.5 h-4 w-4 ${item.tone}`} />
                      <div>
                        <div className="text-sm font-medium">{item.label}</div>
                        <div className="text-xs leading-5 text-muted-foreground">{item.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>
        </Section>

        <Section eyebrow="Agents" title="Org snippets and quick scan identity">
          <div className="grid gap-4 md:grid-cols-3">
            {storybookAgents.map((agent) => (
              <Card key={agent.id} className="shadow-none">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <Identity name={agent.name} size="lg" />
                    <StatusBadge status={agent.status} />
                  </div>
                  <CardDescription>{agent.title}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="leading-6 text-muted-foreground">{agent.capabilities}</p>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline">{agent.role}</Badge>
                    <Badge variant="outline">{agent.adapterType}</Badge>
                    <Badge variant="outline" className="gap-1">
                      <WalletCards className="h-3 w-3" />
                      ${(agent.spentMonthlyCents / 100).toFixed(0)} spent
                    </Badge>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>

        <Section eyebrow="Quicklook" title="Side-panel density reference">
          <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <Card className="shadow-none">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Inbox className="h-4 w-4" />
                  Inbox slice
                </CardTitle>
                <CardDescription>Small panels should keep controls reachable without nested cards.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Unread</span>
                  <span className="font-mono">7</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>Needs review</span>
                  <span className="font-mono">3</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span>Blocked</span>
                  <span className="font-mono">1</span>
                </div>
              </CardContent>
            </Card>
            <div className="rounded-xl border border-border bg-background/70 p-5">
              <div className="mb-4 flex items-center gap-2 text-sm font-medium">
                <Eye className="h-4 w-4 text-muted-foreground" />
                Review target
              </div>
              <IssueRow
                issue={storybookIssues[0]!}
                selected
                unreadState="visible"
                onMarkRead={() => undefined}
                desktopTrailing={<PriorityIcon priority="high" showLabel />}
                trailingMeta="active run"
              />
            </div>
          </div>
        </Section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Control Plane Surfaces",
  component: ControlPlaneSurfaces,
  parameters: {
    docs: {
      description: {
        component:
          "Product-surface stories exercise the board UI components that carry Paperclip's task, approval, budget, activity, and agent governance workflows.",
      },
    },
  },
} satisfies Meta<typeof ControlPlaneSurfaces>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BoardStateMatrix: Story = {};
