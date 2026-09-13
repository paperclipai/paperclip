import { AiReviewBoundary } from "./AiReviewFrame";
import { AiConnectorPages } from "./AiConnectorPages";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ModelSourceTiles } from "@/components/onboarding/ModelSourceTiles";
import {
  AiConnectionAuth,
  type AiAuthState,
} from "@/components/ai-connections/AiConnectionAuth";
import { AiConnectionPicker } from "@/components/ai-connections/AiConnectionPicker";
import {
  AiConnectionLegacyNotice,
} from "@/components/ai-connections/AiConnectionManagement";
import {
  AI_PROVIDERS,
  aiMethodLabel,
  bindingProblem,
  matchesAiRequirement,
  type AiConnectionBinding,
  type AiConnectionRequirement,
  type AiConnectionSummary,
} from "@/components/ai-connections/model";
import {
  AI_REVIEW_BINDING,
  AI_REVIEW_CONNECTIONS,
  AI_REVIEW_REQUIREMENT,
} from "../fixtures/aiConnections";

export interface AiConnectionsReviewProps {
  host?: "onboarding" | "new_agent" | "settings" | "task" | "connections";
  initialStage?: "picker" | "auth" | "manage" | "legacy" | "providers";
  initialConnections?: AiConnectionSummary[];
  initialBinding?: AiConnectionBinding;
  requirement?: AiConnectionRequirement;
  currentUserId?: string;
  initialAuthState?: AiAuthState;
  failFirstAttempt?: boolean;
  readOnly?: boolean;
  loading?: boolean;
  error?: string;
}

/** Storybook-only orchestration. Explicit simulator controls; no provider/network transport. */
export function AiConnectionsReview(props: AiConnectionsReviewProps) {
  if (props.host === "connections") return <AiConnectorPages initialConnections={props.initialConnections} detail={props.initialStage === "manage"} readOnly={props.readOnly} />;
  return <AgentConnectionReview {...props} />;
}

function AgentConnectionReview({
  host = "settings",
  initialStage = "picker",
  initialConnections = AI_REVIEW_CONNECTIONS,
  initialBinding,
  requirement: initialRequirement = AI_REVIEW_REQUIREMENT,
  currentUserId = "dotta",
  initialAuthState = { phase: "idle" },
  failFirstAttempt = false,
  readOnly,
  loading,
  error,
}: AiConnectionsReviewProps) {
  const requirement = initialRequirement;
  const method = requirement.method ?? (requirement.provider === "openrouter" ? "api_key" : "subscription");
  const [connections, setConnections] = useState(initialConnections);
  const [binding, setBinding] = useState<AiConnectionBinding>(
    initialBinding ?? {
      ...AI_REVIEW_BINDING,
      provider: requirement.provider,
      method,
    },
  );
  const [stage, setStage] = useState<string>(
    host === "connections" && initialStage === "picker" ? "list" : initialStage,
  );
  const [auth, setAuth] = useState<AiAuthState>(initialAuthState);
  const [name] = useState(
    `My ${aiMethodLabel(requirement.provider, method) === "API key" ? `${AI_PROVIDERS[requirement.provider].name} API` : aiMethodLabel(requirement.provider, method)}`,
  );
  const [tested, setTested] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasFailed, setHasFailed] = useState(false);
  const [connectionError, setConnectionError] = useState(error);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnFocusLabel = useRef<string | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const problem = bindingProblem(
    binding,
    requirement,
    connections,
    currentUserId,
    "nova",
  );
  const titles = {
    onboarding: "Connect your model provider",
    new_agent: "Connect Nova",
    settings: "Nova · Configuration",
    task: "Nova needs an AI connection",
    connections: "Connections",
  };
  const runtime =
    requirement.provider === "openai"
      ? ["Codex", "Configured OpenAI model"]
      : requirement.provider === "anthropic"
        ? ["Claude Code", "Configured Claude model"]
        : requirement.provider === "xai"
          ? ["Grok Build", "Configured Grok model"]
          : ["OpenCode", "Configured OpenRouter model"];

  function restoreFocus() {
    requestAnimationFrame(() => {
      const target = returnFocus.current?.isConnected
        ? returnFocus.current
        : Array.from(
            region.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          ).find((button) => button.textContent === returnFocusLabel.current);
      target?.focus();
    });
  }
  function openAuth() {
    returnFocus.current = document.activeElement as HTMLElement;
    returnFocusLabel.current = returnFocus.current?.textContent ?? null;
    setAuth({ phase: "idle" });
    setStage("auth");
  }
  function connected() {
    if (failFirstAttempt && !hasFailed) {
      setHasFailed(true);
      setAuth({
        phase: "error",
        message:
          "The provider could not verify this account. Check your credentials and try again.",
      });
      return;
    }
    const id = `review-account-${connections.length + 1}`;
    const connection: AiConnectionSummary = {
      ...requirement, method, id, grantId: `grant-${id}`, name: name.trim(),
      ownership: "personal", ownerUserId: currentUserId,
      ownerName: currentUserId === "dotta" ? "Dotta" : "Sam",
      isDefault: !connections.some((row) => matchesAiRequirement(row, requirement) && row.ownerUserId === currentUserId && row.isDefault),
      status: "connected",
    };
    setConnections((rows) => [...rows, connection]);
    setAuth({ phase: "connected" });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6" ref={region}>
      <aside
        className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-xs text-muted-foreground"
        aria-label="Storybook simulator"
      >
        <span>
          Storybook-only controls · These simulate provider responses and do not appear in the app.
        </span>
        {stage === "auth" &&
          auth.phase === "waiting" &&
          requirement.provider !== "anthropic" && (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              onClick={connected}
            >
              Simulate provider completion
            </Button>
          )}
        {stage === "auth" &&
          (auth.phase === "waiting" || auth.phase === "starting") && (
            <Button
              size="sm"
              variant="ghost"
              className="self-start"
              onClick={() =>
                setAuth({
                  phase: "expired",
                  message:
                    "This sign-in attempt expired. Start again to receive a new code.",
                })
              }
            >
              Simulate expired attempt
            </Button>
          )}
      </aside>
      <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      <p className="text-xs text-muted-foreground">Example page context · Storybook only</p>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold">{titles[host]}</h2>
        {host === "onboarding" && (
          <p className="text-sm text-muted-foreground">
            Connect → Configure agent → First task
          </p>
        )}
        {host === "task" && (
          <p className="text-sm text-muted-foreground">
            Connect an account for the responsible user to continue this task.
          </p>
        )}
      </div>
      {host !== "connections" && (
        <dl className="flex flex-wrap gap-6 text-sm" aria-label="Agent runtime">
          <div>
            <dt className="text-xs text-muted-foreground">Harness</dt>
            <dd data-testid="ai-harness">{runtime[0]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Model</dt>
            <dd data-testid="ai-model">{runtime[1]}</dd>
          </div>
        </dl>
      )}
      </div>
      {stage === "list" && <AiConnectorPages initialConnections={connections} />}
      {stage === "legacy" && (
        <AiConnectionLegacyNotice
          readOnly={readOnly}
          onAdopt={() => {
            setAdopting(true);
            setStage("picker");
          }}
        />
      )}
      {stage === "picker" && (
        <>
          {adopting && (
            <p className="text-sm text-muted-foreground">
              Confirm this account’s ownership and use, then test it before
              replacing existing authentication.
            </p>
          )}
          <AiReviewBoundary label="App component: AiConnectionPicker">
          <AiConnectionPicker
            requirement={requirement}
            connections={connections}
            value={binding}
            currentUserId={currentUserId}
            agentId="nova"
            agentName="Nova"
            loading={loading}
            error={connectionError}
            readOnly={readOnly}
            onRetry={() => setConnectionError(undefined)}
            onChange={(next) => {
              setBinding(next);
              setTested(false);
              setSaved(false);
            }}
            onConnect={() => openAuth()}
          />
          </AiReviewBoundary>
          {!readOnly && !loading && !connectionError && (
            <div className="space-y-2">
            <p className="text-xs text-muted-foreground">Example form actions · Storybook only</p>
            <div className="flex flex-wrap gap-2">
              {adopting && (
                <Button
                  variant="outline"
                  disabled={Boolean(problem)}
                  onClick={() => setTested(true)}
                >
                  Test selected connection
                </Button>
              )}
              <Button
                disabled={Boolean(problem) || (adopting && !tested)}
                onClick={() => {
                  setSaved(true);
                  setStage("saved");
                }}
              >
                {adopting
                  ? "Adopt connection"
                  : host === "settings"
                    ? "Save connection"
                    : "Continue"}
              </Button>
            </div>
            </div>
          )}
          {tested && (
            <p role="status" className="text-sm">
              Connection test passed for{" "}
              {currentUserId === "dotta" ? "Dotta" : "Sam"}. Harness and model
              are unchanged.
            </p>
          )}
        </>
      )}
      {stage === "auth" && (
        <>
          <ModelSourceTiles
            label="Model provider"
            sources={[
              {
                id: requirement.provider,
                label: AI_PROVIDERS[requirement.provider].name,
                icon: AI_PROVIDERS[requirement.provider].logo ? (
                  <img
                    src={AI_PROVIDERS[requirement.provider].logo}
                    className={
                      requirement.provider === "xai"
                        ? "size-6 dark:invert"
                        : "size-6"
                    }
                    alt=""
                  />
                ) : null,
              },
            ]}
            mode={requirement.method === "api_key" ? "api" : "subscription"}
            selectedId={requirement.provider}
            collapsed
            onSelect={() => {}}
          />
          <AiReviewBoundary label="Simulated authentication controller: AiConnectionAuth · Reuses existing login cards">
          <AiConnectionAuth
            provider={requirement.provider}
            method={method}
            state={auth}
            onStart={() => {
              if (!name.trim()) return;
              setAuth({
                phase: "waiting",
                authorizationUrl: "#storybook-provider-simulator",
                code: "DEMO-CODE",
              });
            }}
            onSubmit={() => {
              if (name.trim()) connected();
            }}
            onCancel={() => {
              setAuth({ phase: "cancelled" });
              setStage("picker");
              restoreFocus();
            }}
            onDone={() => {
              setStage("picker");
              restoreFocus();
            }}
          />
          </AiReviewBoundary>
        </>
      )}
      {stage === "saved" && (
        <>
          <p role="status" className="text-sm">
            {saved
              ? adopting
                ? "Managed connection adopted."
                : "Connection selected for Nova."
              : "Connection saved."}{" "}
            Harness and model are unchanged.
          </p>
          <p className="text-sm text-muted-foreground">
            The account remains in Connections even if you leave agent setup.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setSaved(false);
              setAdopting(false);
              setStage("picker");
            }}
          >
            Create another agent using existing connections
          </Button>
          <Button variant="ghost" onClick={() => setStage("list")}>
            View Connections
          </Button>
        </>
      )}
    </div>
  );
}
