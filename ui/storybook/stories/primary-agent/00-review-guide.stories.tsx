import type { Meta, StoryObj } from "@storybook/react-vite";

const surfaces = [
  ["01 Components", "crown-indicator", "Primary indicator", "Identity and crown presentation only; absent primary, loading, long names."],
  ["02 Sidebar", "idle-primary", "Agents sidebar", "Pinned idle primary, active colleagues, independent stars, collapsed section, mobile drawer, classic shell."],
  ["03 Agents", "specialist-profile", "Agent list and profile", "Set as my primary on the individual page; crown beside the primary’s name, first-created agent, paused and unavailable states."],
  ["04 New task", "primary-fallback", "New-task composer", "Primary fallback, recent specialist, explicit assignment, restored draft, mobile."],
  ["05 Chat", "primary-fallback", "Chat", "Full production Chat page and navigation; recent conversation, primary fallback, chooser, paused state, mobile."],
  ["06 Journeys", "switch-primary", "Interactive journeys", "Switch from an agent’s page, keep stars, recover a failed save, leave a primary, and start work."],
  ["07 Confirmation", "replace-primary", "Switch confirmation", "Current and new agent avatars, named warning, cancel/confirm, long names, mobile, and light theme."],
];
const storyLink = (group: string, story: string) => `/?path=/story/primary-agent-${group.toLowerCase().replaceAll(" ", "-")}--${story}`;

function ReviewGuide() {
  return <main className="min-h-screen bg-background p-6 text-foreground md:p-10">
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Design review · Primary Agent</p>
        <h1 className="text-3xl font-semibold">Your main point of contact</h1>
        <p className="max-w-3xl text-base text-muted-foreground">One crown per person, per company. Your first agent receives it automatically. Recent choices take precedence; the crown is your fallback.</p>
        <a className="inline-flex rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href={storyLink("06 Journeys", "switch-primary")} target="_top">Start the walkthrough</a>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-muted"><tr><th className="p-3">Surface</th><th className="p-3">Review coverage</th></tr></thead>
          <tbody>{surfaces.map(([group, id, label, coverage]) => <tr key={group} className="border-t border-border">
            <td className="p-3 align-top"><a className="font-medium text-primary underline underline-offset-4" href={storyLink(group!, id!)} target="_top">{label}</a></td>
            <td className="p-3 text-muted-foreground">{coverage}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <section className="max-w-3xl space-y-3 text-sm text-muted-foreground">
        <h2 className="text-xl font-semibold text-foreground">What to try</h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>Open an agent’s page and choose Set as my primary beneath its details. If you already have a primary, review the two avatars and named warning before confirming. Cancel preserves your current primary.</li>
          <li>When no primary exists, choosing one applies immediately without a confirmation modal. The selected agent’s profile and list row receive the crown; it moves to the top of the Agents sidebar.</li>
          <li>Inspect both sidebars and the agent kebab menus: they have no crown or primary action. The current primary has no removal option.</li>
          <li>Star or unstar an agent. Stars remain independent of your primary choice.</li>
          <li>Compare the new-task and Chat scenarios. A recent specialist wins over Maia; an explicit choice or saved draft is preserved.</li>
          <li>Try the failed-save journey twice: the first attempt rolls back, the second succeeds.</li>
          <li>Use the light-theme and mobile stories. Change the editable primary name in Controls to inspect truncation.</li>
        </ol>
      </section>
      <section className="max-w-3xl space-y-3 text-sm text-muted-foreground">
        <h2 className="text-xl font-semibold text-foreground">Review boundary</h2>
        <p>The pages, menus, avatars, composer, and app shell are production components. Preferences, first-creation results, fallback routing, and server responses are isolated Storybook simulations. Reload resets a story; no real agents run and no company data changes.</p>
        <p>The live app has retired the collapsed icon rail. Coverage uses the supported collapsible Agents section and mobile drawer instead. In the streamlined shell, the proposed Agents section is supplied through Layout’s existing sidebar slot; the classic shell uses its existing section.</p>
        <p>Persistence, migration, API authorization, and production default selection come after this review. These stories remain the implementation reference.</p>
      </section>
    </div>
  </main>;
}
export default { title: "Primary Agent/00 Review guide", parameters: { layout: "fullscreen" }, render: () => <ReviewGuide /> } satisfies Meta;
export const StartHere: StoryObj = {};
