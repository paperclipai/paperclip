import { reviewGroups, reviewPath, Surface } from "./shared";

const existing = [
  [
    "AI Connections / Review",
    "ai-connections-review--review-index",
    "Catalog, account ownership, authentication, task repair, and legacy adoption",
  ],
  [
    "Onboarding / Agent arc",
    "onboarding-agent-arc--connect-a-model",
    "Current first onboarding, using the production wizard",
  ],
  [
    "Onboarding / Saved connections",
    "onboarding-saved-connections--claude-api-keys",
    "Existing account reuse",
  ],
  [
    "Onboarding / New agent",
    "onboarding-new-agent--interactive-flow",
    "Hire, connect, configure, and test",
  ],
  [
    "Agents / Configuration refresh",
    "agents-configuration-refresh--runtime",
    "Harness, model, environment, and save controls",
  ],
  [
    "AI Connections / Inline task",
    "ai-connections-review--inline-task-connection",
    "Current connection request and inline Fix connection flow",
  ],
] as const;
const descriptions = [
  "Review scope, ownership, existing surfaces, and decisions.",
  "Sign in, choose a model, test, and finish. Other providers stay under Advanced.",
  "Familiar accounts first; OpenRouter, Bedrock, and custom endpoints under Advanced providers.",
  "Everyday account and model selection, then optional advanced providers, aliases, and validation.",
  "Connection list, destinations, credential replacement, models, helper defaults, and access.",
  "Task-level reconnect, missing personal credentials, protocol failure, and quota failure.",
  "Implemented provider setup and compatible connection selector, rendered directly from production components.",
];
export function ReviewIndex() {
  return (
    <Surface
      title="Provider routing · Start here"
      description="Review the neighboring groups below. Groups 01–05 explore the design; 06 renders the implemented production components with fixture data."
    >
      <ol className="flex flex-col gap-4">
        {reviewGroups.slice(1).map(([group, story, label], index) => (
          <li key={group} className="space-y-1">
            <a
              className="font-medium underline underline-offset-4"
              href={reviewPath(group, story)}
              target="_top"
            >
              {index + 1}. {label}
            </a>
            <p className="text-sm text-muted-foreground">
              {descriptions[index + 1]}
            </p>
          </li>
        ))}
      </ol>
      <section className="space-y-3">
        <h2 className="font-semibold">Simple by default</h2>
        <p className="text-sm text-muted-foreground">
          Start with Default path or Happy path walkthrough in Onboarding, then
          Codex new runner or Claude default in Agent. Sign in with the normal
          account, choose a model, and test. The Connection dropdown lists saved
          connections compatible with the harness, including configured
          gateways. Provider URLs, custom provider setup, and custom model entry
          stay behind an explicit Advanced action.
        </p>
        <p className="text-sm text-muted-foreground">
          Advanced providers stories show the expanded controls. Configured
          gateway shows the everyday view after setup: the connection name and
          selected model remain visible while its technical settings are folded
          away. Closing Advanced preserves every selection and validation error.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Where these changes live</h2>
        <p className="text-sm text-muted-foreground">
          Agent settings live at Agents → Nova → Harness / Runtime. The Agent
          stories render the existing settings page, sidebar, and header, with
          the proposed connection controls in its runtime section.
        </p>
        <p className="text-sm text-muted-foreground">
          Manage uses the existing Connectors provider cards and account rows.
          Setup reuses the Access cards, agent picker, and API key form. Agent
          selection uses the existing harness dropdown, connection choices,
          model picker, and test card. Recovery uses the existing inline Fix
          connection flow. Destination and model routing fields are the proposed
          additions.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Decisions to review</h2>
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>
            The connection owns the destination and authentication. The agent
            owns its harness and selected model.
          </li>
          <li>
            First onboarding keeps its usual sign-in path. The optional provider
            link is inside Advanced; additional setup uses Access → Connect.
          </li>
          <li>
            Changing a connection preserves the harness and asks for a
            compatible model when needed.
          </li>
          <li>
            Tests run in the selected environment. A key being accepted does not
            establish model/tool compatibility.
          </li>
          <li>
            A new endpoint creates a new connection; changing a personal default
            never silently selects another destination.
          </li>
        </ul>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Included harnesses</h2>
        <p className="text-sm text-muted-foreground">
          Codex, Claude Code, OpenCode, Grok Build, Pi, Gemini CLI, Kimi CLI,
          and Hermes local. Both runner paths are represented where available.
          Cursor is shown as unverified for custom endpoints; native Pi and
          Copilot show their qualification boundary. Fixture model IDs are
          examples, not a validated provider catalog.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Excluded from this update</h2>
        <p className="text-sm text-muted-foreground">
          OpenClaw Gateway, Hermes Gateway, Claude Managed, AWS AgentCore,
          Process, HTTP, and legacy acpx_local are out of scope. Remote/custom
          integrations retain model configuration in the agent service or
          runtime they invoke. Legacy acpx_local is retired. This exclusion does
          not remove Claude/Grok’s ACPX-backed new runner or Hermes local from
          the review.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="font-semibold">Existing stories reviewed</h2>
        {existing.map(([label, id, detail]) => (
          <div key={id} className="space-y-1">
            <a
              href={`/?path=/story/${id}`}
              target="_top"
              className="text-sm underline underline-offset-4"
            >
              {label}
            </a>
            <p className="text-xs text-muted-foreground">{detail}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-muted-foreground">
        Use example credentials only. In the recovery demo, “invalid” simulates
        rejection. Stories reset on navigation. Local state and intercepted
        fixture APIs keep credentials, tests, and settings in the preview;
        nothing is sent to a provider or Paperclip server.
      </p>
    </Surface>
  );
}
