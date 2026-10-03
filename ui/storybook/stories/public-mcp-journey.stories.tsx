import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

interface JourneyStep {
  title: string;
  place: string;
  why: string;
  action: string;
  outcome: string;
  question: string;
  story?: string;
  peer?: boolean;
  scene?: string[][];
}

const steps: JourneyStep[] = [
  {
    "title": "Meet Alex and Acme Research",
    "place": "Start of the story",
    "why": "Alex leads Acme Research and works in Codex or Claude. Alex wants a researcher to compare three competitors, keep working after the chat closes, and leave a report the team can find later.",
    "action": "Use Next step to tell the story in order. Use the numbered steps to jump to a screen during discussion.",
    "outcome": "The assistant is Alex’s interface. Paperclip holds the team, task, progress, permissions, and result.",
    "question": "Can a user explain what remains in Paperclip when the conversation ends?",
    "scene": [
      [
        "Alex’s goal",
        "“Ask our researcher to compare three competitors and produce a sourced report.”"
      ],
      [
        "The journey",
        "Enable access → connect the right organization → delegate → return for the result → manage access."
      ],
      [
        "What you can try here",
        "Product screens use isolated fixtures. Example conversations explain the workflow; they do not call an LLM or create real work. Each step starts with fresh sample state."
      ]
    ]
  },
  {
    "title": "Enable assistant access",
    "place": "Paperclip · Settings → Experimental",
    "why": "Before Alex can connect, an instance administrator enables Assistant connections (MCP). The experiment starts off.",
    "action": "Find Assistant connections (MCP) and turn it on. Other settings on this page are existing Paperclip experiments.",
    "outcome": "The instance can accept assistant connections. This does not connect an account, create an organization, or start an agent. Paid execution still needs its own configuration.",
    "question": "Is it clear that enabling access and granting a particular assistant access are separate decisions?",
    "story": "assistant-connections-experimental-setting--disabled-by-default"
  },
  {
    "title": "Arrive from Codex or Claude",
    "place": "Assistant → browser → Paperclip",
    "why": "Alex configures the Paperclip MCP connection in the assistant and starts browser sign-in. Hosted customers choose their organization in Cloud before reviewing access to that same organization.",
    "action": "For the hosted sign-in and organization-creation screens, open the Cloud walkthrough. For this walkthrough, continue as Alex returning from Cloud.",
    "outcome": "Alex arrives with Acme Research fixed on the connection request. A self-hosted connection reaches the instance directly and can choose an organization there.",
    "question": "Does the handoff make sense: Cloud selects the organization; Paperclip reviews its permissions?",
    "peer": true,
    "scene": [
      [
        "Hosted route",
        "Assistant → Cloud sign-in → choose or create organization → Paperclip consent → assistant."
      ],
      [
        "Self-hosted route",
        "Assistant → reachable Paperclip instance → sign-in, organization choice, and consent → assistant."
      ],
      [
        "Availability",
        "These PRs supply the connection flow. Public directory listings require separate deployment and submission. This walkthrough does not assume a published listing."
      ]
    ]
  },
  {
    "title": "Review organization permissions",
    "place": "Paperclip · Acme Research consent",
    "why": "Alex is connecting as a person, not becoming the researcher. The selected organization and Alex’s granted permissions bound every subsequent tool call.",
    "action": "Acme Research is already selected from Cloud. Review the organization icon and name. Write access starts enabled for delegation and feedback; uncheck it for read-only access, then click Connect organization. Preview redirects stay in this frame; then use Next step.",
    "outcome": "Read access permits summaries and results. Write access also permits task creation and comments, which may wake or queue an agent. The organization stays fixed for this request. To connect a different organization, start a new connection from the assistant.",
    "question": "Would Alex understand that “delegate to researcher” does not let the assistant impersonate that agent?",
    "story": "assistant-connections-consent--hosted-organization"
  },
  {
    "title": "Review the connected organization",
    "place": "Back in Codex or Claude · example conversation",
    "why": "Alex checks which organization is connected and which agents are available before assigning work.",
    "action": "Read the sample conversation aloud. The assistant should identify the organization and check agent availability instead of guessing from the chat.",
    "outcome": "Alex knows which organization will receive the task. A paused or unavailable researcher needs attention in Paperclip before execution can proceed.",
    "question": "Are the connected organization and human identity visible enough to prevent a task going to the wrong organization?",
    "scene": [
      [
        "Alex",
        "“Which Paperclip organization am I connected to, and who can do competitor research?”"
      ],
      [
        "Assistant · illustrative response",
        "“You’re connected to Acme Research as Alex. I’ll check the agents and their availability before assigning the research.”"
      ],
      [
        "What supports this",
        "The connection and agent-list tools supply the identity and available agents. This panel is an example, not a captured model response."
      ]
    ]
  },
  {
    "title": "Delegate a durable task",
    "place": "Codex or Claude → Paperclip · example conversation",
    "why": "Alex asks the team to do work. The assistant creates a task assigned to an available Paperclip agent; Paperclip controls when it runs.",
    "action": "Read the request and response. Notice that the response gives a durable task reference and describes the scheduling effect.",
    "outcome": "One task exists in Paperclip and is submitted to its scheduler. A task reference is not evidence that execution has started or finished. Retries must reuse the request’s idempotency key.",
    "question": "Does the response distinguish “task created” from “research completed”?",
    "scene": [
      [
        "Alex",
        "“Have our researcher compare Acme’s three main competitors. Include sources and save the report on the task.”"
      ],
      [
        "Assistant · illustrative response",
        "“Created ACM-42, Competitor comparison, assigned to Researcher. This submits work to Paperclip’s scheduler and may start paid execution under the team’s settings. Keep ACM-42 to check progress later.”"
      ],
      [
        "In Paperclip",
        "The task is attributed to Alex. The researcher runs with its configured credentials, execution capacity, budget, and approvals. The assistant’s connection does not provide those."
      ]
    ]
  },
  {
    "title": "Return for results and give feedback",
    "place": "A later assistant conversation · example",
    "why": "Alex closes the original chat and returns later. The task and documents remain in Paperclip.",
    "action": "Read the follow-up, then the feedback. Events-capable clients can subscribe to updates explicitly; other clients can check the task when asked.",
    "outcome": "The assistant reads current progress and the saved deliverable. A comment records Alex’s feedback and can wake or queue more work. Pending approvals link to Paperclip for a decision.",
    "question": "Can Alex recover the result without remembering the original conversation?",
    "scene": [
      [
        "Alex · later",
        "“What happened with ACM-42? Read the completed report and summarize the evidence.”"
      ],
      [
        "Assistant · illustrative response after reading a completed task",
        "“ACM-42 is complete. I found the saved competitor report and can summarize it with its source links.”"
      ],
      [
        "Alex · feedback",
        "“Add a comment asking Researcher to include pricing changes.”"
      ],
      [
        "Assistant · illustrative response",
        "“Added your feedback to ACM-42 as Alex. That comment may wake or queue the researcher.”"
      ],
      [
        "Optional follow-up",
        "In an Events-capable client, Alex can explicitly ask to watch the task. Connecting alone does not subscribe, and event support depends on the client."
      ]
    ]
  },
  {
    "title": "Manage or revoke the connection",
    "place": "Paperclip · Assistant connections",
    "why": "Alex can see which clients have access, which organization each connection reaches, and whether it can write.",
    "action": "Compare Codex’s Acme Research access with Claude’s read-only Design Partners connection. Click Revoke connection on Codex.",
    "outcome": "The Codex connection becomes revoked. Subsequent requests with it are denied. Work already delegated remains in Paperclip; revocation does not cancel the task.",
    "question": "Is the scope and consequence of revoking access understandable?",
    "story": "assistant-connections-manage-connections--connected"
  }
];

function GuidedJourney() {
  const [index, setIndex] = useState(0);
  const [previewVersion, setPreviewVersion] = useState(0);
  const step = steps[index]!;
  // Relative URLs work on both dev servers and published static Storybooks.
  const storyUrl = step.story ? `./iframe.html?id=${step.story}&viewMode=story&globals=theme:dark` : undefined;
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const companionUrl = isLocal ? `${window.location.protocol}//${window.location.hostname}:6107/?path=/story/assistant-connections-start-here--guided-walkthrough` : undefined;
  return (
    <main className="mx-auto flex max-w-screen-2xl flex-col gap-6 p-6 text-sm" aria-label="Paperclip assistant connection walkthrough">
      <header className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">STORYBOOK WALKTHROUGH · PAPERCLIP</p>
        <h1 className="text-xl font-bold">Acme Research in Alex’s assistant</h1>
        <p className="text-muted-foreground">A guided story you can present, pause, and try. Screen actions affect only sample data; Next step advances the explanation.</p>
      </header>
      <nav className="flex flex-wrap gap-2" aria-label="Journey steps">
        {steps.map((item, i) => <button key={item.title} type="button" aria-current={i === index ? "step" : undefined} className={`rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-accent ${i === index ? "bg-accent font-semibold" : ""}`} onClick={() => setIndex(i)}>{i + 1}. {item.title}</button>)}
      </nav>
      <nav aria-label="Walkthrough controls" className="flex items-center justify-between gap-4 border-t border-border bg-background py-4">
        <button type="button" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent disabled:opacity-50" disabled={index === 0} onClick={() => setIndex(i => i - 1)}>Back</button>
        <span className="text-xs text-muted-foreground">{index + 1} / {steps.length} · {index === steps.length - 1 ? "End of this walkthrough" : `Next: ${steps[index + 1]!.title}`}</span>
        <button type="button" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => setIndex(i => i === steps.length - 1 ? 0 : i + 1)}>{index === steps.length - 1 ? "Restart walkthrough" : "Next step"}</button>
      </nav>
      <div className="grid gap-6 sm:grid-cols-3">
        <section className="flex flex-col gap-4" aria-label="Presenter notes" aria-live="polite">
          <div className="flex flex-col gap-1"><p className="text-xs text-muted-foreground">Step {index + 1} of {steps.length} · {step.place}</p><h2 className="text-lg font-semibold">{step.title}</h2></div>
          <p>{step.why}</p>
          <div className="flex flex-col gap-1"><h3><strong>Try / narrate</strong></h3><p>{step.action}</p></div>
          <div className="flex flex-col gap-1"><h3><strong>What happens next</strong></h3><p>{step.outcome}</p></div>
          <div className="flex flex-col gap-1"><h3><strong>Talk about this</strong></h3><p className="text-muted-foreground">{step.question}</p></div>
          {step.peer && <div className="flex flex-col gap-1">
            {companionUrl && <a className="text-primary underline underline-offset-4" href={companionUrl} target="_blank" rel="noreferrer">Open Cloud walkthrough ↗</a>}
            <p className="text-xs text-muted-foreground">Cloud Storybook → Assistant connections → Start here → Guided walkthrough. {companionUrl ? "Local companion on port 6107." : "Open the companion repository’s Storybook separately."}</p>
          </div>}
        </section>
        <section className="min-w-0 sm:col-span-2" aria-label="Current scene">
          {storyUrl ? <>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3 text-xs text-muted-foreground"><span>REAL PRODUCT SCREEN · MOCKED SERVICES</span><button className="text-primary underline underline-offset-4" type="button" onClick={() => setPreviewVersion(v => v + 1)}>Reset this screen</button></div>
            <iframe key={`${index}:${previewVersion}`} className="h-screen max-h-screen w-full border-0" src={storyUrl} title={`${step.title} — interactive product preview`} />
          </> : <div className="flex flex-col gap-6 rounded-lg border border-border bg-card p-6">
            <p className="text-xs text-muted-foreground">ILLUSTRATIVE SCENARIO · NO LIVE ASSISTANT OR EXECUTION</p>
            {step.scene?.map(([label, text]) => <div key={label} className="flex flex-col gap-1"><h3><strong>{label}</strong></h3><p>{text}</p></div>)}
          </div>}
        </section>
      </div>

    </main>
  );
}
const meta = {
  title: "Assistant connections/Start here",
  component: GuidedJourney,
  parameters: { layout: "fullscreen", shell: "none" },
} satisfies Meta<typeof GuidedJourney>;
export default meta;
type Story = StoryObj<typeof meta>;
export const GuidedWalkthrough: Story = {};
/** Separate from the presentation so opening it never auto-advances the story. */
export const NavigationCheck: Story = { play: async ({ canvasElement }) => {
  const c = within(canvasElement);
  await expect(c.getByRole("button", { name: "Back" })).toBeDisabled();
  await userEvent.click(c.getByRole("button", { name: "Next step" }));
  await expect(c.getByRole("heading", { name: steps[1]!.title })).toBeVisible();
  await userEvent.click(c.getByRole("button", { name: `${steps.length}. ${steps[steps.length - 1]!.title}` }));
  await expect(c.getByRole("button", { name: "Restart walkthrough" })).toBeVisible();
  await userEvent.click(c.getByRole("button", { name: "Back" }));
  await expect(c.getByRole("heading", { name: steps[steps.length - 2]!.title })).toBeVisible();
  await userEvent.click(c.getByRole("button", { name: "Next step" }));
  await userEvent.click(c.getByRole("button", { name: "Restart walkthrough" }));
  await expect(c.getByRole("heading", { name: steps[0]!.title })).toBeVisible();
} };
