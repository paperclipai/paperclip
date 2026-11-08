import { AiReviewBoundary } from "./AiReviewFrame";
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { APP_DEFINITIONS, type ConnectionIntentInteraction } from "@paperclipai/shared";
import { ConnectionIntentInteractionBody } from "@/features/connections/ConnectionIntentInteractionBody";
import { ConnectionSetupFlow, type ConnectionSetupFlowProps } from "@/features/connections/ConnectionSetupFlow";
import { pendingConnectionIntentInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { AiConnectionAuth, type AiAuthState } from "@/components/ai-connections/AiConnectionAuth";
import { AI_REVIEW_CONNECTIONS } from "../fixtures/aiConnections";
import { storybookAgents } from "../fixtures/paperclipData";

const initial: ConnectionIntentInteraction = {
  ...pendingConnectionIntentInteraction,
  id: "ai-task-request", companyId: "company-storybook", addresseeUserId: "dotta",
  payload: { version: 1, purpose: "ai", serviceSlug: "anthropic", serviceName: "Claude", serviceLogoUrl: "/brands/claude-color.svg", requestingAgentId: "nova", requestingAgentName: "Nova", phase: "requested" },
};

/** The actual task connection request card, modal, reuse flow and focus lifecycle. */
export function AiTaskConnectionReview({ reuse = false }: { reuse?: boolean }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let interaction = initial;
    const previous = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
      const path = url.pathname;
      const app = APP_DEFINITIONS.find((entry) => entry.slug === "anthropic")!;
      const payload = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      if (path.startsWith("/api/connection-intents/ai-task-request/")) {
        if (path.endsWith("/complete")) interaction = { ...interaction, status: "accepted", result: { version: 1, outcome: "connected", connectionId: payload.connectionId } };
        if (path.endsWith("/decline")) interaction = { ...interaction, status: "rejected", result: { version: 1, outcome: "declined" } };
        if (path.endsWith("/phase")) interaction = { ...interaction, payload: { ...interaction.payload, phase: payload.phase } };
        return Response.json(path.endsWith("setup-options") ? {
          version: 1, interaction, service: { service: "anthropic", name: "Claude", methods: [], state: "needs_user_action", connectionId: null },
          aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" }, requestedAgentId: "nova", existingConnections: reuse ? [{ id: "claude-dotta", applicationId: "app-anthropic", name: AI_REVIEW_CONNECTIONS[0].name, status: "active", enabled: true }] : [],
        } : interaction);
      }
      if (path === "/api/companies/company-storybook/tools/gallery") return Response.json({ apps: [{ ...app, name: "Claude" }], capabilities: { canCreateOrganizationGrant: false, canSetCompanyInstall: false } });
      if (path === "/api/companies/company-storybook/agents") return Response.json([{ ...storybookAgents[0], id: "nova", name: "Nova" }]);
      if (path === "/api/ai-review-interactions") return Response.json([interaction]);
      return previous(input, init);
    };
    setReady(true);
    return () => { window.fetch = previous; client.clear(); };
  }, [client, reuse]);
  return ready ? <QueryClientProvider client={client}><TaskCard /></QueryClientProvider> : null;
}
function TaskCard() {
  const query = useQuery({ queryKey: ["issues", "interactions", "ai-review"], queryFn: async (): Promise<ConnectionIntentInteraction[]> => (await fetch("/api/ai-review-interactions")).json() });
  const interaction = query.data?.[0];
  return <main className="mx-auto max-w-3xl space-y-6 p-6">
    <p className="text-xs text-muted-foreground">Example task context · Storybook only</p>
    <h1 className="text-lg font-semibold">Nova needs your Claude connection</h1>
    <p className="text-sm text-muted-foreground">Existing task connection request · Fixture data. Harness: Claude Code. Model: Configured Claude model.</p>
    {interaction && <AiReviewBoundary label="Existing app component: ConnectionIntentInteractionBody"><ConnectionIntentInteractionBody interaction={interaction} currentUserId="dotta" addresseeLabel="Dotta" renderSetup={(props) => <TaskSetup {...props} />} /></AiReviewBoundary>}
  </main>;
}
function TaskSetup(props: ConnectionSetupFlowProps) {
  const [state, setState] = useState<AiAuthState>({ phase: "idle" });
  return <ConnectionSetupFlow {...props} renderCredentialStep={() => <AiReviewBoundary label="Simulated authentication controller · Existing login cards"><AiConnectionAuth provider="anthropic" method="subscription" state={state}
    onStart={() => setState({ phase: "waiting", authorizationUrl: "https://example.test/review-login" })}
    onSubmit={() => setState({ phase: "connected" })}
    onCancel={() => props.onCancel?.()}
    onDone={() => props.onComplete?.({ connectionId: "review-task-claude" })}
  /></AiReviewBoundary>} />;
}
