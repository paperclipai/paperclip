import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import {
  Briefcase,
  Calendar,
  CheckCircle2,
  Cloud,
  FileText,
  Github,
  Mail,
  MessageSquare,
  Radio,
  Search,
  Shield,
  Video,
  Workflow,
  Wrench,
} from "lucide-react";

const connectorGroups = [
  {
    title: "Best first-wave connectors",
    description: "These are the highest-value OAuth integrations for per-agent MCP access. Good coverage across email, files, chat, docs, tickets, and code.",
    items: [
      {
        name: "Google Workspace",
        icon: Mail,
        status: "Recommended first",
        summary: "Gmail, Calendar, Drive, Docs, Sheets, and Contacts in one login.",
        why: ["Best single OAuth win for agent usefulness", "Covers inbox, scheduling, files, and documents", "Very common for founders, ops, and small teams"],
        scopes: ["gmail", "calendar", "drive", "docs", "sheets", "contacts"],
      },
      {
        name: "Microsoft 365",
        icon: Calendar,
        status: "Recommended first",
        summary: "Outlook, Calendar, OneDrive, Teams, and Office docs.",
        why: ["Enterprise counterpart to Google Workspace", "Huge install base", "Necessary if agents target corporate environments"],
        scopes: ["mail", "calendar", "files", "teams"],
      },
      {
        name: "Slack",
        icon: MessageSquare,
        status: "Recommended first",
        summary: "Read/send messages, search channels, and work with internal conversations.",
        why: ["Extremely common collaboration surface", "Agents become useful faster with chat context", "Natural MCP fit for search + action"],
        scopes: ["chat", "channels", "history", "search"],
      },
      {
        name: "GitHub",
        icon: Github,
        status: "Recommended first",
        summary: "Issues, PRs, repos, code search, and CI status.",
        why: ["High-value for engineering agents", "Already a standard agent workflow surface", "Great fit for MCP tools"],
        scopes: ["repos", "issues", "pull requests", "actions"],
      },
    ],
  },
  {
    title: "Strong second wave",
    description: "Useful once the core set is live. These cover docs, project management, CRM, and knowledge workflows.",
    items: [
      {
        name: "Notion",
        icon: FileText,
        status: "High demand",
        summary: "Workspace docs, databases, and internal knowledge.",
        why: ["Popular knowledge base for startups", "Useful for retrieval and drafting", "Often requested alongside Slack + Google"],
        scopes: ["pages", "databases", "search"],
      },
      {
        name: "Jira",
        icon: Workflow,
        status: "High demand",
        summary: "Enterprise issue tracking and project operations.",
        why: ["Very common in larger teams", "Strong workflow value", "Pairs well with Slack and GitHub"],
        scopes: ["issues", "projects", "comments"],
      },
      {
        name: "Linear",
        icon: CheckCircle2,
        status: "High demand",
        summary: "Modern issue tracking for product and engineering teams.",
        why: ["Popular with AI-native/product teams", "Clean API and good agent ergonomics", "Smaller surface than Jira"],
        scopes: ["issues", "projects", "cycles"],
      },
      {
        name: "HubSpot",
        icon: Briefcase,
        status: "High demand",
        summary: "CRM, contacts, deals, and email engagement.",
        why: ["Strong value for sales and support agents", "Common SMB/default CRM", "Useful once agents move beyond pure engineering"],
        scopes: ["contacts", "companies", "deals", "engagements"],
      },
      {
        name: "YouTube",
        icon: Video,
        status: "High demand",
        summary: "Channel management, video metadata, comments, and publishing workflows.",
        why: ["Strong fit for creator, media, and research agents", "Pairs naturally with Google Workspace auth ecosystems", "Useful for content ops beyond plain document workflows"],
        scopes: ["channels", "videos", "comments", "analytics"],
      },
      {
        name: "Twitter / X",
        icon: Radio,
        status: "High demand",
        summary: "Posting, search, mentions, timelines, and lightweight social monitoring.",
        why: ["Useful for social, founder, and community-facing agents", "High value for monitoring and response workflows", "Good fit when agents need public-surface awareness"],
        scopes: ["posts", "mentions", "timeline", "search"],
      },
    ],
  },
  {
    title: "Later / specialised",
    description: "Worth supporting, but less important than the first two waves for launch.",
    items: [
      {
        name: "Salesforce",
        icon: Cloud,
        status: "Enterprise",
        summary: "Heavyweight enterprise CRM and workflow system.",
        why: ["Huge enterprise footprint", "Important for serious sales ops", "Higher implementation overhead than HubSpot"],
        scopes: ["accounts", "contacts", "opportunities"],
      },
      {
        name: "Zendesk",
        icon: Shield,
        status: "Support",
        summary: "Tickets, customer support queues, and knowledge workflows.",
        why: ["Great for support agents", "Not universal enough for first-wave", "Pairs well with Slack + HubSpot"],
        scopes: ["tickets", "users", "articles"],
      },
      {
        name: "Google Ads / Meta Ads",
        icon: Search,
        status: "Marketing",
        summary: "Campaigns, reporting, and optimisation workflows.",
        why: ["Useful for marketing agents", "Narrower audience", "Worth adding after office/work tools"],
        scopes: ["campaigns", "reporting"],
      },
      {
        name: "Custom MCP Connector",
        icon: Wrench,
        status: "Extensibility",
        summary: "Bring your own OAuth-enabled MCP endpoint.",
        why: ["Covers long tail", "Lets power users move early", "Good fallback while first-party catalog grows"],
        scopes: ["custom"],
      },
    ],
  },
] as const;

function statusTone(status: string) {
  if (status === "Recommended first") return "default" as const;
  if (status === "High demand") return "secondary" as const;
  return "outline" as const;
}

export function Connectors() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors" }]);
  }, [setBreadcrumbs]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Connectors</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Per-agent OAuth connections for MCP-style tools. The right shape here is: each agent owns its own app connections,
            so one agent can have Google Workspace while another only has GitHub or Slack.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled>
            OAuth provider settings soon
          </Button>
          <Button disabled>Connect app</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recommended launch set</CardTitle>
          <CardDescription>
            If we want the highest-value "one click connect" experience, the strongest first batch is:
            <span className="ml-1 font-medium text-foreground">Google Workspace, Microsoft 365, Slack, and GitHub.</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border p-4">
            <div className="font-medium text-foreground">Why Google first</div>
            <p className="mt-1">One OAuth grant unlocks email, calendar, files, docs, sheets, and contacts.</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-medium text-foreground">Why Microsoft second</div>
            <p className="mt-1">Needed for enterprise customers where Google is a non-starter.</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-medium text-foreground">Why Slack third</div>
            <p className="mt-1">Makes agents operationally useful inside real team conversation flow.</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="font-medium text-foreground">Why GitHub fourth</div>
            <p className="mt-1">It’s the obvious engineering workflow connector and already fits the product well.</p>
          </div>
        </CardContent>
      </Card>

      {connectorGroups.map((group) => (
        <section key={group.title} className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">{group.title}</h2>
            <p className="text-sm text-muted-foreground">{group.description}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-5">
            {group.items.map((item) => {
              const Icon = item.icon;
              return (
                <Card key={item.name} className="h-full">
                  <CardHeader className="space-y-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="rounded-lg border p-2 text-muted-foreground">
                          <Icon className="h-5 w-5" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{item.name}</CardTitle>
                          <CardDescription className="mt-1 text-xs">{item.summary}</CardDescription>
                        </div>
                      </div>
                      <Badge variant={statusTone(item.status)}>{item.status}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Why add it</div>
                      <ul className="space-y-2 text-sm text-muted-foreground">
                        {item.why.map((reason) => (
                          <li key={reason} className="flex gap-2">
                            <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                            <span>{reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div>
                      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Likely scope surface</div>
                      <div className="flex flex-wrap gap-2">
                        {item.scopes.map((scope) => (
                          <Badge key={scope} variant="outline">{scope}</Badge>
                        ))}
                      </div>
                    </div>
                    <Button className="w-full" variant="outline" disabled>
                      Coming soon
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
