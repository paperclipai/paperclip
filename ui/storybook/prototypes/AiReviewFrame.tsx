import type { ReactNode } from "react";

/** Review annotations live only in Storybook; none of this frame ships in the app. */
export function AiReviewFrame({ location, existing, proposed, wrapper, children }: {
  location: string;
  existing: string;
  proposed: string;
  wrapper: string;
  children: ReactNode;
}) {
  return <div className="mx-auto max-w-6xl p-4 sm:p-6" data-testid="ai-review-frame">
    <aside aria-label="Storybook context" className="mb-4 space-y-3 rounded-lg border border-dashed border-border bg-muted p-4">
      <p className="text-xs font-semibold uppercase tracking-wide">Storybook only · Review guide</p>
      <p className="text-sm"><strong>Intended app location:</strong> {location}</p>
      <dl className="grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="font-semibold">Already in the app</dt><dd className="mt-1 text-muted-foreground">{existing}</dd></div>
        <div><dt className="font-semibold">Integrated AI component</dt><dd className="mt-1 text-muted-foreground">{proposed}</dd></div>
        <div><dt className="font-semibold">Storybook simulation</dt><dd className="mt-1 text-muted-foreground">{wrapper}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">Dashed frames and labels are review annotations. Accounts and provider responses are fixtures. The components are integrated in the app; these stories use simulated accounts and authentication.</p>
    </aside>
    <div className="overflow-hidden rounded-lg border border-border bg-background" data-testid="ai-review-preview">{children}</div>
  </div>;
}

/** Marks a precise component boundary within a simulated page or an existing app page. */
export function AiReviewBoundary({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0 space-y-3 rounded-lg border border-dashed border-border p-3" data-testid="ai-component-boundary">
    <p className="text-xs font-medium text-muted-foreground">{label} · Review annotation</p>
    {children}
  </div>;
}

export function aiReviewContext(id: string, args: { host?: string; initialStage?: string }) {
  const story = id.replace("ai-connections-review--", "");
  if (story === "review-index") return {
    location: "This is a Storybook review index. It has no app location.",
    existing: "The linked stories identify the existing pages they use.",
    proposed: "The linked stories identify the new AI-specific components.",
    wrapper: "This entire index and its links exist only for review.",
  };
  if (story.startsWith("inline-task")) return {
    location: "A task → connection request card → Connect / Use existing modal.",
    existing: "ConnectionIntentInteractionBody: the task card, modal, reuse chooser and focus handling. ConnectionSetupFlow: access/setup steps.",
    proposed: "AI authentication content inside that existing setup flow.",
    wrapper: "The example task title, Nova, accounts and successful continuation are simulated. There is no live task or run.",
  };
  if (args.host === "connections" || story === "identity-matrix") {
    const detail = args.initialStage === "manage";
    return {
      location: detail ? "Connectors → choose an account → account permissions/details." : "Connectors (/:company/apps) → provider → Add account or open an account.",
      existing: detail ? "AppDetail: header/rename, ownership display and agent-access controls. BreadcrumbBar supplies existing page navigation. The existing revoke dialog and reconnect banner are reused." : "Browse: provider groups, account rows, search and menus. Navigation opens the existing AppDetail and ConnectionSetupFlow components.",
      proposed: detail ? "The marked AI account section: personal default and AI credential actions." : "AI provider/account fixture entries and their method/default labels. AI-specific sections are marked when you open an account or sign in.",
      wrapper: "This frame, page margins and in-memory API. The page components are real; the AI accounts and all changes are simulated.",
    };
  }
  const location = args.host === "onboarding" ? "Onboarding → existing provider connection step."
    : args.host === "new_agent" ? "Create agent → provider/harness configuration → AI connection field."
    : args.host === "task" ? "A task blocked on its responsible user’s AI credentials. This story isolates the picker; see Inline task connection for the real task host."
    : "Agent → configuration → AI connection field beside harness/model.";
  return {
    location,
    existing: "ConnectionChoiceList (extracted from connection setup), AppLogo, and the existing onboarding subscription/API-key cards and fields.",
    proposed: "The marked AI connection picker and authentication composition. The app uses these controls beside its harness/model settings.",
    wrapper: "The Nova heading, harness/model values, save/continue buttons and simulator controls form a mock page. They are not the real agent configuration form.",
  };
}
