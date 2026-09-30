import type { Meta, StoryObj } from "@storybook/react-vite";

const surfaces = [
  [
    "NewIssueDialog",
    "Changed",
    "01 Creation",
    "open-by-default",
    "Open and private creation; inherited child; private/personal project; restored draft; submit failure; mobile/light.",
  ],
  [
    "IssueShareSheet",
    "Added",
    "02 Sharing",
    "all-access-sources",
    "All four grant sources; implicit roles; read-only; inherited; sticky assignment; add/revoke; confirmations; agent cautions; loading/error/retry; long names; mobile/light.",
  ],
  [
    "IssuePrivacyActions",
    "Added",
    "03 Task actions",
    "private-owner",
    "Private/open owner; reader permissions; admin; public confirmation and failed save; mobile.",
  ],
  [
    "LockedIssueChip",
    "Added",
    "04 References and blockers",
    "locked-chip-variants",
    "Identifier, missing identifier, neutral unavailable state, and no link or quicklook.",
  ],
  [
    "IssueReferencePill",
    "Changed",
    "04 References and blockers",
    "reference-pill-variants",
    "Readable and locked references, mention and property variants, light theme.",
  ],
  [
    "MarkdownBody",
    "Changed",
    "04 References and blockers",
    "markdown-mentions",
    "Readable and unavailable links/bare mentions; pending lookup without premature navigation.",
  ],
  [
    "IssueBlockedNotice",
    "Changed",
    "04 References and blockers",
    "mixed-blockers",
    "Private blocker alone and mixed with readable blockers.",
  ],
  [
    "RemovableIssueReferencePill (relation-controls)",
    "Changed",
    "04 References and blockers",
    "remove-blocker-confirmation",
    "Desktop detach; mobile action menu without Visit task; both confirmation layouts; successful removal.",
  ],
  [
    "ProjectProperties",
    "Changed",
    "05 Projects",
    "private-project-settings",
    "Open/private/personal project; owner/reader/admin gates; full settings context; light theme.",
  ],
  [
    "ProjectAccessMembers",
    "Added",
    "05 Projects",
    "member-list",
    "Owner protection; reader; shared-agent caution; loading; directory/member/add/remove failures; successful add; mobile.",
  ],
  [
    "IssueDetail",
    "Changed",
    "06 Full product pages",
    "owner-sharing-from-menu",
    "Real page and task menu; sharing survives menu dismissal; owner/reader/admin; shared child with locked ancestor; mobile/light.",
  ],
  [
    "IssueProperties",
    "Changed",
    "06 Full product pages",
    "shared-child-reader",
    "Private parent remains a locked, non-interactive chip in task properties.",
  ],
  [
    "RelationNavigationList (TaskDetailRelationsPanel)",
    "Changed",
    "04 References and blockers",
    "ancestor-navigation",
    "Mixed readable and locked ancestors; also shown in the full task's Tasks tab.",
  ],
  [
    "DesignGuide",
    "Changed",
    "06 Full product pages",
    "design-guide-locked-references",
    "Actual design-guide page, scrolled to the new locked-reference section.",
  ],
];
function storyLink(group: string, story: string) {
  return `./?path=/story/private-tasks-${group.toLowerCase().replaceAll(" ", "-")}--${story}`;
}
const journeys = [
  [
    "CEO · Create a private task",
    "ceo-creates-private-task",
    "Choose Private task before saving a personal briefing.",
  ],
  [
    "CEO · Share only a child",
    "ceo-shares-only-child",
    "Invite Morgan to research; the parent briefing and sibling compensation task remain outside the grant.",
  ],
  [
    "Owner · Revoke a grant",
    "owner-revokes-an-explicit-grant",
    "Review the warning, revoke Morgan's saved grant, and see the list update.",
  ],
  [
    "Owner · Assignment remains",
    "current-assignment-still-grants-access",
    "Remove a saved agent grant while the current assignment still supplies access.",
  ],
  [
    "Owner · Make public",
    "owner-makes-task-public",
    "Confirm disclosure; private children retain their restrictions.",
  ],
  [
    "Reader · Detach a blocker",
    "reader-detaches-private-blocker",
    "Remove a visible relationship without learning private content.",
  ],
  [
    "Project owner · Add a member",
    "owner-adds-project-member",
    "Find Sam in the company directory and grant project access.",
  ],
];
function Overview() {
  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-6xl space-y-8">
        <header className="max-w-3xl space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Private tasks · Review guide
          </p>
          <h1 className="text-3xl font-semibold">
            Every changed surface, in context
          </h1>
          <p className="text-sm text-muted-foreground">
            This review covers all 14 rendered components and pages changed by
            the private-task feature: four additions and ten existing surfaces.
            Each canvas uses the production component with fictional, isolated
            API fixtures.
          </p>
          <p className="rounded-lg border border-border bg-muted p-4 text-sm">
            Privacy flows down the task tree. Sharing a child grants access to
            that child and its descendants. Ancestors and siblings need a
            separate grant.
          </p>
        </header>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Start with the user stories</h2>
          <p className="text-sm text-muted-foreground">
            These seven journeys run their interactions automatically and leave
            the resulting screen visible. Use the Storybook interactions panel
            to inspect each named step, or reload a component story to explore
            manually.
          </p>
          <div className="grid gap-3 md:grid-cols-2">
            {journeys.map(([name, id, description]) => (
              <a
                key={id}
                href={storyLink("07 User stories", id!)}
                target="_top"
                className="space-y-1 rounded-lg border border-border bg-card p-4 hover:bg-accent"
              >
                <h3 className="text-sm font-semibold">{name}</h3>
                <p className="text-sm text-muted-foreground">{description}</p>
              </a>
            ))}
          </div>
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">
            Complete component inventory
          </h2>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="p-3">Production surface</th>
                  <th className="p-3">Change</th>
                  <th className="p-3">Review coverage</th>
                </tr>
              </thead>
              <tbody>
                {surfaces.map(([name, change, group, id, coverage]) => (
                  <tr key={name} className="border-t border-border">
                    <td className="p-3 align-top font-medium">
                      <a
                        href={storyLink(group!, id!)}
                        target="_top"
                        className="text-primary underline underline-offset-4"
                      >
                        {name}
                      </a>
                    </td>
                    <td className="p-3 align-top text-muted-foreground">
                      {change}
                    </td>
                    <td className="p-3 text-muted-foreground">{coverage}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="max-w-3xl space-y-3 text-sm text-muted-foreground">
          <h2 className="text-xl font-semibold text-foreground">
            How to review
          </h2>
          <ol className="list-decimal space-y-2 pl-5">
            <li>
              Walk the seven user stories, then use the inventory to inspect
              every component's individual states.
            </li>
            <li>
              Use the theme and viewport toolbar for any canvas. Explicit
              mobile/light stories preserve important review views.
            </li>
            <li>
              Inspect the full task pages to verify menu integration, permission
              gates, locked ancestry, and layout.
            </li>
            <li>
              Reload a story to reset its in-memory changes. No story connects
              to Gmail or changes a real company's data.
            </li>
          </ol>
          <p>
            Server-only changes—authorization, search filtering, notification
            delivery, run/workspace history, connector credentials, and
            descendant propagation—do not add independent UI components. The
            displayed responses model those outcomes; a Storybook interaction is
            not evidence of backend security enforcement.
          </p>
        </section>
      </div>
    </main>
  );
}
export default {
  title: "Private tasks/00 Review guide",
  parameters: { layout: "fullscreen", docs: { story: { inline: false } } },
  render: () => <Overview />,
} satisfies Meta;
export const CoverageAndUserStories: StoryObj = {};
