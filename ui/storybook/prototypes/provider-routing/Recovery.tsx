import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import { ConnectionIntentInteractionBody } from "@/features/connections/ConnectionIntentInteractionBody";
import type { ConnectionSetupFlowProps } from "@/features/connections/ConnectionSetupFlow";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { pendingConnectionIntentInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { Footer, Notice, Surface } from "./shared";

type Problem = "expired" | "missing" | "protocol" | "quota";
const initial: ConnectionIntentInteraction = {
  ...pendingConnectionIntentInteraction,
  id: "provider-routing-repair",
  companyId: "company-storybook",
  addresseeUserId: "dotta",
  payload: {
    version: 1,
    purpose: "ai",
    serviceSlug: "connection:gateway",
    serviceName: "Engineering gateway",
    requestingAgentId: "nova",
    requestingAgentName: "Nova",
    phase: "requested",
  },
};

export function Recovery({ problem = "expired" }: { problem?: Problem }) {
  return (
    <Surface
      title="Review the release checklist"
      description="Task PC-142 · Assigned to Nova"
    >
      <p className="text-sm text-muted-foreground">
        Codex · Engineering gateway · engineering-coder
      </p>
      {problem === "protocol" || problem === "quota" ? (
        <Notice error>
          <p>
            {problem === "protocol"
              ? "This endpoint serves Chat Completions. Codex needs Responses with streaming and tool support."
              : "Engineering gateway is at its usage limit. The credential is connected; wait for capacity or choose another authorized connection."}
          </p>
          <a
            className="underline underline-offset-4"
            href="/?path=/story/ai-connections-provider-routing-03-agent--codex-new-runner"
            target="_top"
          >
            Review agent configuration
          </a>
        </Notice>
      ) : (
        <TaskRepair problem={problem} />
      )}
    </Surface>
  );
}

/** Use the production task card, inline setup, completion and focus lifecycle. Only API replies are fixtures. */
function TaskRepair({ problem }: { problem: "expired" | "missing" }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      }),
  );
  const [interaction, setInteraction] = useState(initial);
  const current = useRef(initial);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    window.fetch = async (input, init) => {
      const path = new URL(
        input instanceof Request ? input.url : String(input),
        window.location.origin,
      ).pathname;
      if (!path.startsWith("/api/connection-intents/provider-routing-repair/"))
        return previous(input, init);
      if (path.endsWith("/complete")) {
        current.current = {
          ...current.current,
          status: "accepted",
          result: { version: 1, outcome: "connected", connectionId: "gateway" },
        };
        setInteraction(current.current);
        return Response.json(current.current);
      }
      if (path.endsWith("/setup-options"))
        return Response.json({
          version: 1,
          interaction: current.current,
          service: {
            service: "connection:gateway",
            name: "Engineering gateway",
            methods: [],
            state: "needs_user_action",
            connectionId: "gateway",
          },
          requestedAgentId: "nova",
          existingConnections: [],
        });
      return Response.json(
        { error: "Unsupported Storybook operation" },
        { status: 400 },
      );
    };
    setReady(true);
    return () => {
      window.fetch = previous;
      client.clear();
    };
  }, [client]);
  return ready ? (
    <QueryClientProvider client={client}>
      <ConnectionIntentInteractionBody
        interaction={interaction}
        currentUserId="dotta"
        addresseeLabel="Dotta"
        renderSetup={(props) => (
          <GatewayCredential {...props} problem={problem} />
        )}
      />
    </QueryClientProvider>
  ) : (
    <p role="status">Loading connection request…</p>
  );
}

function GatewayCredential({
  problem,
  onCancel,
  onComplete,
}: ConnectionSetupFlowProps & { problem: Problem }) {
  const [credential, setCredential] = useState("");
  const [failed, setFailed] = useState(false);
  const connect = () => {
    if (!credential.trim()) return;
    setCredential("");
    if (credential === "invalid") {
      setFailed(true);
      return;
    }
    onComplete?.({ connectionId: "gateway" });
  };
  return (
    <section aria-label="Gateway credential repair" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {problem === "missing"
          ? "Connect your own credential for this destination."
          : "Replace the expired credential for this destination."}{" "}
        The harness and selected model stay the same.
      </p>
      <p className="break-all font-mono text-xs">
        https://models.example.com/v1 · OpenAI Responses
      </p>
      <ProviderApiKeyCard
        providerName="Engineering gateway"
        value={credential}
        onChange={(value) => {
          setCredential(value);
          setFailed(false);
        }}
        onSubmit={connect}
        autoFocus
      />
      {failed && (
        <Notice error>
          The provider rejected this credential. Enter another key and retry.
        </Notice>
      )}
      <Footer
        back="Cancel"
        onBack={() => {
          setCredential("");
          onCancel?.();
        }}
        next="Connect"
        onNext={connect}
        disabled={!credential.trim()}
      />
    </section>
  );
}
