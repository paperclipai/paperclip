import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RuntimeTestCard, type TestState } from "@/components/RuntimeTestCard";
import { ModelSourceTiles } from "@/components/onboarding/ModelSourceTiles";
import { CredentialModeLink } from "@/components/onboarding/CredentialModeLink";
import { AdapterMark } from "@/components/AdapterMark";
import {
  AdapterTypeDropdown,
  ModelDropdown,
} from "@/components/AgentConfigForm";
import { Field } from "@/components/agent-config-primitives";
import { ConnectionChoiceList } from "@/features/connections/ConnectionChoiceList";
import { AiConnectionLegacyNotice } from "@/components/ai-connections/AiConnectionManagement";
import { AgentSettingsPreview } from "../agent-settings/AgentSettingsPreview";
import { ProviderApiKeyCard } from "@/components/AdapterLoginChrome";
import { ConnectionSetup } from "./ConnectionSetup";
import { ConnectionPicker } from "./ConnectionPicker";
import {
  AdvancedOptions,
  Choice,
  Footer,
  Notice,
  Surface,
  TextField,
} from "./shared";
import {
  compatibility,
  connections,
  defaultConnection,
  harnesses,
  modelsFor,
  type Connection,
  type Harness,
} from "./model";

export type AgentProps = {
  harness?: Harness;
  runner?: "new" | "legacy";
  initialConnectionId?: string;
  addedConnection?: Connection;
  initialModel?: string;
  initialTest?: TestState;
  scenario?:
    | "normal"
    | "empty"
    | "loading"
    | "catalog-error"
    | "denied"
    | "missing-personal"
    | "legacy"
    | "readonly";
  testFailure?: "tools" | "network";
  newAgent?: boolean;
  initialAdvanced?: boolean;
};

const adapterTypes: Record<Harness, string> = {
  codex: "codex_local",
  claude: "claude_local",
  opencode: "opencode_local",
  grok: "grok_local",
  pi: "pi_local",
  gemini: "gemini_local",
  kimi: "kimi_local",
  hermes: "hermes_local",
  cursor: "cursor",
  copilot: "copilot_local",
};
const excludedAdapters = new Set([
  "process",
  "http",
  "openclaw_gateway",
  "hermes_gateway",
  "claude_managed",
  "aws_agentcore",
  "acpx_local",
  "paperclip_runner",
  "cursor_cloud",
]);

export function AgentSetup(props: AgentProps) {
  const content = <AgentRoutingFields {...props} />;
  return props.newAgent ? (
    content
  ) : (
    <AgentSettingsPreview
      initialTab="runtime"
      adapterType={adapterTypes[props.harness ?? "codex"]}
      runtimeContent={content}
    />
  );
}

function AgentRoutingFields({
  harness: initialHarness = "codex",
  runner = "new",
  initialConnectionId,
  addedConnection,
  initialModel,
  initialTest = "idle",
  scenario = "normal",
  testFailure,
  newAgent,
  initialAdvanced = false,
}: AgentProps) {
  const startingConnection =
    addedConnection ??
    connections.find((entry) => entry.id === initialConnectionId) ??
    defaultConnection(initialHarness);
  const [harness, setHarness] = useState(initialHarness);
  const [rows, setRows] = useState(
    addedConnection
      ? [
          ...connections.filter((entry) => entry.id !== addedConnection.id),
          addedConnection,
        ]
      : scenario === "empty"
        ? []
        : connections,
  );
  const [connectionId, setConnectionId] = useState(startingConnection.id);
  const [model, setModel] = useState(
    initialModel ?? modelsFor(startingConnection, harness)[0],
  );
  const [manual, setManual] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(initialAdvanced);
  const [effort, setEffort] = useState("default");
  const [environment, setEnvironment] = useState("cloud");
  const [state, setState] = useState<TestState>(initialTest);
  const [catalogError, setCatalogError] = useState(
    scenario === "catalog-error",
  );
  const [creating, setCreating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const selected = rows.find((entry) => entry.id === connectionId);
  const availableModels = selected ? modelsFor(selected, harness) : [];
  const unknownModel = !manual && !availableModels.includes(model);
  const reason = selected ? compatibility(selected, harness) : undefined;
  const denied = scenario === "denied" || scenario === "missing-personal";
  const readOnly = scenario === "readonly";
  const nativePending =
    runner === "new" &&
    !harnesses.find((entry) => entry.value === harness)!.native;
  const invalid =
    !selected ||
    !!reason ||
    unknownModel ||
    !model.trim() ||
    denied ||
    nativePending ||
    readOnly;
  const change = () => {
    clearTimeout(timer.current);
    setState("idle");
    setSaved(false);
    setDiscarded(false);
  };
  const error =
    testFailure === "network"
      ? "This endpoint is unreachable from the selected environment. Check network access or choose another environment."
      : "The model responded, but the tool-call test failed. Choose a model with tool support or check the gateway’s API format.";
  const test = () => {
    setState("running");
    timer.current = setTimeout(
      () => setState(testFailure ? "fail" : "pass"),
      400,
    );
  };

  if (creating)
    return (
      <ConnectionSetup
        initialAdvanced={advancedOpen}
        onCancel={() => setCreating(false)}
        onComplete={(connection) => {
          setRows((current) => [
            ...current.filter((entry) => entry.id !== connection.id),
            connection,
          ]);
          setConnectionId(connection.id);
          setCreating(false);
          change();
        }}
      />
    );
  return (
    <Surface
      embedded={!newAgent}
      title={newAgent ? "Configure Nova" : "Harness, connection & model"}
      description="Choose a harness and model, then test your agent."
    >
      <fieldset
        disabled={readOnly}
        aria-label="Harness selection"
        className="min-w-0"
      >
        <Field label="Harness">
          <AdapterTypeDropdown
            value={adapterTypes[harness]}
            disabledTypes={excludedAdapters}
            onChange={(value) => {
              const next = (Object.keys(adapterTypes) as Harness[]).find(
                (key) => adapterTypes[key] === value,
              );
              if (next) {
                setHarness(next);
                change();
              }
            }}
          />
        </Field>
      </fieldset>
      {nativePending && (
        <Notice error>
          This harness is not yet available through Paperclip Runner. Select a
          supported harness or configure its legacy adapter.
        </Notice>
      )}
      {scenario === "legacy" && (
        <AiConnectionLegacyNotice
          readOnly={readOnly}
          onAdopt={() => setCreating(true)}
        />
      )}
      {scenario === "loading" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading your connections…
        </p>
      ) : selected ? (
        <>
          <ConnectionPicker
            selected={selected}
            connections={rows.filter((entry) => !compatibility(entry, harness))}
            disabled={readOnly}
            onSelect={(id) => {
              if (id === connectionId) return;
              setConnectionId(id);
              setManual(false);
              change();
            }}
            onConnect={() => setCreating(true)}
          />
          {reason && (
            <Notice error>{reason} Choose a compatible connection.</Notice>
          )}
          {denied && (
            <Notice error>
              {scenario === "missing-personal"
                ? "Sam has no credential for Engineering gateway. Sam needs to connect to this destination, or choose an authorized company credential."
                : "You don’t have access to this company credential. Ask its owner for access or choose another connection."}
            </Notice>
          )}
        </>
      ) : (
        <Notice>
          No compatible connections yet. Connect a provider to choose a model
          for Nova.
        </Notice>
      )}
      {!selected && (
        <Button
          variant="link"
          className="h-auto justify-start self-start p-0"
          disabled={readOnly || scenario === "loading"}
          onClick={() => setCreating(true)}
        >
          Connect an account
        </Button>
      )}
      {selected && scenario !== "loading" && (
        <>
          {catalogError ? (
            <Notice error>
              <p>Couldn’t load models from this connection.</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => setCatalogError(false)}
              >
                Retry model discovery
              </Button>
            </Notice>
          ) : (
            <fieldset
              disabled={readOnly || Boolean(reason)}
              aria-label="Model selection"
              className="min-w-0"
            >
              <ModelDropdown
                models={availableModels.map((id) => ({ id, label: id }))}
                value={model}
                open={modelOpen}
                onOpenChange={setModelOpen}
                allowDefault={false}
                required
                groupByProvider={selected.provider === "openrouter"}
                creatable={advancedOpen}
                onChange={(value) => {
                  setManual(!availableModels.includes(value));
                  setModel(value);
                  change();
                }}
              />
            </fieldset>
          )}
          {catalogError && advancedOpen && (
            <TextField
              label="Model ID or alias"
              value={model}
              disabled={readOnly}
              onChange={(event) => {
                setManual(true);
                setModel(event.target.value);
                change();
              }}
              hint="Use the exact ID accepted by this connection. Custom model metadata is managed on the connection."
            />
          )}
          {unknownModel && !catalogError && (
            <Notice error>
              Your previous model is unavailable through {selected.name}. Choose
              a model to continue. Your harness is still{" "}
              {harnesses.find((entry) => entry.value === harness)!.label}.
            </Notice>
          )}
          <Choice
            label="Reasoning"
            value={effort}
            disabled={readOnly}
            onChange={(value) => {
              setEffort(value);
              change();
            }}
            options={[
              { value: "default", label: "Model default" },
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ]}
          />
          <Choice
            label="Execution environment"
            value={environment}
            disabled={readOnly}
            onChange={(value) => {
              setEnvironment(value);
              change();
            }}
            options={[
              { value: "cloud", label: "Company AWS workspace" },
              { value: "local", label: "Local machine" },
            ]}
          />
          <AdvancedOptions
            label="Advanced model settings"
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
          >
            <Button
              variant="link"
              className="h-auto self-start p-0"
              disabled={readOnly}
              onClick={() => setCreating(true)}
            >
              Connect another provider or gateway
            </Button>
            <p className="text-xs text-muted-foreground">
              To use a custom model ID or gateway alias, enter it in the Model
              picker above.
            </p>
          </AdvancedOptions>
          <RuntimeTestCard
            state={state}
            onTest={test}
            disabled={invalid || (catalogError && !manual)}
            error={error}
            result={
              state === "pass" || state === "fail"
                ? {
                    adapterType: harness,
                    status: state,
                    testedAt: "2026-10-02T12:00:00Z",
                    checks: [
                      {
                        code: "destination",
                        level: "info",
                        message: `Destination: ${selected.endpoint}`,
                      },
                      {
                        code: "environment",
                        level: "info",
                        message: `Tested in ${environment === "cloud" ? "Company AWS workspace" : "Local machine"}`,
                      },
                      {
                        code: "tools",
                        level: state === "pass" ? "info" : "error",
                        message:
                          state === "pass"
                            ? "Authentication, streaming, tool call, and follow-up passed."
                            : error,
                      },
                    ],
                  }
                : null
            }
          />
        </>
      )}
      {saved && (
        <Notice>
          {scenario === "legacy"
            ? "Managed connection adopted."
            : "Nova’s configuration saved."}{" "}
          {selected?.name} · {model}
        </Notice>
      )}
      {discarded && <Notice>Changes discarded.</Notice>}
      <Footer
        back="Discard"
        onBack={() => {
          setHarness(initialHarness);
          setConnectionId(startingConnection.id);
          setModel(
            initialModel ?? modelsFor(startingConnection, initialHarness)[0],
          );
          setManual(false);
          setEffort("default");
          setEnvironment("cloud");
          change();
          setDiscarded(true);
        }}
        next={
          scenario === "legacy"
            ? "Adopt connection"
            : newAgent
              ? "Finish setup"
              : "Save changes"
        }
        onNext={() => setSaved(true)}
        disabled={invalid || state !== "pass" || scenario === "loading"}
      />
    </Surface>
  );
}

export function Onboarding({
  initialAlternate = false,
  savedConnection = false,
}: {
  initialAlternate?: boolean;
  savedConnection?: boolean;
}) {
  const [stage, setStage] = useState(initialAlternate ? "other" : "default");
  const [mode, setMode] = useState<"subscription" | "api">("subscription");
  const [key, setKey] = useState("");
  const [connection, setConnection] = useState<Connection>();
  if (stage === "other")
    return (
      <ConnectionSetup
        initialAdvanced
        onCancel={() => setStage("default")}
        onComplete={(value) => {
          setConnection(value);
          setStage("agent");
        }}
      />
    );
  if (stage === "agent")
    return (
      <AgentSetup
        harness="codex"
        newAgent
        initialConnectionId="chatgpt"
        addedConnection={connection}
      />
    );
  return (
    <Surface
      title="Connect OpenAI"
      description="You’ve selected Codex for Nova."
    >
      <ModelSourceTiles
        label="Model provider"
        sources={[
          {
            id: "codex",
            label: "OpenAI",
            icon: <AdapterMark type="codex_local" />,
          },
        ]}
        selectedId="codex"
        mode={mode}
        onSelect={() => {}}
      />
      <CredentialModeLink mode={mode} onChange={setMode} />
      {savedConnection ? (
        <ConnectionChoiceList
          selectedId="chatgpt"
          choices={[
            {
              id: "chatgpt",
              name: "My ChatGPT subscription",
              description: "OpenAI · Your subscription",
            },
          ]}
          onSelect={() => {}}
        />
      ) : mode === "api" ? (
        <ProviderApiKeyCard
          providerName="OpenAI"
          value={key}
          onChange={setKey}
          onSubmit={() => {
            if (key.trim()) {
              setConnection({
                ...connections[0],
                id: "openai-key",
                name: "My OpenAI API",
                endpoint: "https://api.openai.com/v1",
                method: "API key",
              });
              setKey("");
              setStage("agent");
            }
          }}
        />
      ) : null}
      <AdvancedOptions>
        <Button
          variant="link"
          className="h-auto self-start p-0"
          onClick={() => setStage("other")}
        >
          Use another provider or gateway
        </Button>
      </AdvancedOptions>
      <Footer
        back="Back"
        onBack={() => {
          setMode("subscription");
          setKey("");
        }}
        next={
          savedConnection
            ? "Use saved connection"
            : mode === "subscription"
              ? "Sign in to OpenAI"
              : "Connect"
        }
        disabled={!savedConnection && mode === "api" && !key.trim()}
        onNext={() => {
          setConnection(
            mode === "api" && !savedConnection
              ? {
                  ...connections[0],
                  id: "openai-key",
                  name: "My OpenAI API",
                  endpoint: "https://api.openai.com/v1",
                  method: "API key",
                }
              : connections[0],
          );
          setKey("");
          setStage("agent");
        }}
      />
    </Surface>
  );
}
