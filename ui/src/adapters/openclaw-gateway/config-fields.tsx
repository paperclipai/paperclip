import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, RefreshCw, AlertTriangle } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import {
  PayloadTemplateJsonField,
  RuntimeServicesJsonField,
} from "../runtime-json-fields";
import { MarkdownEditor } from "../../components/MarkdownEditor";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-background text-foreground outline-none text-sm font-mono [color-scheme:dark] dark:bg-background";

type GatewayAgent = {
  id: string;
  name: string;
  identity?: { name?: string; emoji?: string };
};

type AgentsListResponse = {
  defaultId: string;
  agents: GatewayAgent[];
};

function agentLabel(a: GatewayAgent): string {
  if (a.identity?.name) return a.identity.name;
  return a.name || a.id;
}

type GatewayModel = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

function modelLabel(m: GatewayModel): string {
  const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : "";
  const reasoning = m.reasoning ? " 🧠" : "";
  return `${m.provider}/${m.name}${ctx}${reasoning}`;
}

/** Debounce a value by delayMs */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useGatewayModels(
  wsUrl: string,
  token: string,
): { models: GatewayModel[]; loading: boolean; error: string | null; refresh: () => void } {
  const [models, setModels] = useState<GatewayModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const debouncedUrl = useDebouncedValue(wsUrl, 600);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!debouncedUrl || !token) {
      setModels([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => {
      if (!cancelled) { setError("Connection timed out"); setModels([]); setLoading(false); ws?.close(); }
    }, 15_000);

    setLoading(true);
    setError(null);
    setModels([]);

    try { ws = new WebSocket(debouncedUrl); } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid WebSocket URL");
      setModels([]); setLoading(false); clearTimeout(timer); return;
    }

    ws.onmessage = (event) => {
      if (cancelled) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "event" && frame.event === "connect.challenge") {
          ws?.send(JSON.stringify({
            type: "req", id: "c1", method: "connect",
            params: {
              minProtocol: 3, maxProtocol: 3,
              client: { id: "gateway-client", version: "paperclip", platform: "browser", mode: "backend" },
              role: "operator", scopes: ["operator.admin"],
              ...(token ? { auth: { token } } : {}),
            },
          }));
          return;
        }
        if (frame.type === "res" && frame.id === "c1") {
          if (!frame.ok) { setError(frame.error?.message ?? "Connect failed"); setModels([]); setLoading(false); clearTimeout(timer); ws?.close(); return; }
          ws?.send(JSON.stringify({ type: "req", id: "ml", method: "models.list", params: {} }));
          return;
        }
        if (frame.type === "res" && frame.id === "ml") {
          clearTimeout(timer);
          if (!frame.ok) { setError(frame.error?.message ?? "models.list failed"); setModels([]); setLoading(false); ws?.close(); return; }
          setModels((frame.payload as { models: GatewayModel[] }).models ?? []);
          setLoading(false);
          ws?.close();
        }
      } catch { /* ignore */ }
    };

    ws.onerror = () => { if (!cancelled) { setError("WebSocket connection error"); setModels([]); setLoading(false); clearTimeout(timer); } };
    ws.onclose = () => { clearTimeout(timer); };
    return () => { cancelled = true; clearTimeout(timer); ws?.close(); };
  }, [debouncedUrl, token, refreshKey]);

  return { models, loading, error, refresh };
}

function useGatewayAgents(
  wsUrl: string,
  token: string,
): { agents: GatewayAgent[]; defaultId: string | null; loading: boolean; error: string | null; refresh: () => void } {
  const [agents, setAgents] = useState<GatewayAgent[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const debouncedAgentUrl = useDebouncedValue(wsUrl, 600);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!debouncedAgentUrl || !token) {
      setAgents([]);
      setDefaultId(null);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    let ws: WebSocket | null = null;
    const timer = setTimeout(() => {
      if (!cancelled) {
        setError("Connection timed out");
        setAgents([]);
        setDefaultId(null);
        setLoading(false);
        ws?.close();
      }
    }, 15_000);

    setLoading(true);
    setError(null);
    setAgents([]);
    setDefaultId(null);

    try {
      ws = new WebSocket(debouncedAgentUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid WebSocket URL");
      setAgents([]);
      setDefaultId(null);
      setLoading(false);
      clearTimeout(timer);
      return;
    }

    ws.onmessage = (event) => {
      if (cancelled) return;
      try {
        const frame = JSON.parse(String(event.data));
        if (frame.type === "event" && frame.event === "connect.challenge") {
          ws?.send(
            JSON.stringify({
              type: "req",
              id: "c1",
              method: "connect",
              params: {
                minProtocol: 3,
                maxProtocol: 3,
                client: { id: "gateway-client", version: "paperclip", platform: "browser", mode: "backend" },
                role: "operator",
                scopes: ["operator.admin"],
                ...(token ? { auth: { token } } : {}),
              },
            }),
          );
          return;
        }
        if (frame.type === "res" && frame.id === "c1") {
          if (!frame.ok) {
            setError(frame.error?.message ?? "Connect failed");
            setAgents([]); setDefaultId(null);
            setLoading(false);
            clearTimeout(timer);
            ws?.close();
            return;
          }
          ws?.send(
            JSON.stringify({ type: "req", id: "al", method: "agents.list", params: {} }),
          );
          return;
        }
        if (frame.type === "res" && frame.id === "al") {
          clearTimeout(timer);
          if (!frame.ok) {
            setError(frame.error?.message ?? "agents.list failed");
            setAgents([]); setDefaultId(null);
            setLoading(false);
            ws?.close();
            return;
          }
          const data = frame.payload as AgentsListResponse;
          setAgents(data.agents ?? []);
          setDefaultId(data.defaultId ?? null);
          setLoading(false);
          ws?.close();
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onerror = () => {
      if (!cancelled) {
        setError("WebSocket connection error");
        setAgents([]); setDefaultId(null);
        setLoading(false);
        clearTimeout(timer);
      }
    };

    ws.onclose = () => {
      clearTimeout(timer);
    };

    return () => {
      cancelled = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [debouncedAgentUrl, token, refreshKey]);

  return { agents, defaultId, loading, error, refresh };
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

function parseScopes(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return typeof value === "string" ? value : "";
}

function ModelSelector({
  wsUrl,
  token,
  value,
  onChange,
}: {
  wsUrl: string;
  token: string;
  value: string;
  onChange: (model: string) => void;
}) {
  const { models, loading, error, refresh } = useGatewayModels(wsUrl, token);

  // Group models by provider for a cleaner dropdown
  const providers = models.reduce<Record<string, GatewayModel[]>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});

  return (
    <Field label="Model override">
      <div className="flex gap-1.5 items-center">
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className={selectClass + " flex-1"}
          disabled={loading}
        >
          <option value="">
            {loading ? "Fetching models..." : models.length === 0 ? "Agent default" : "Agent default (no override)"}
          </option>
          {Object.entries(providers).map(([provider, providerModels]) => (
            <optgroup key={provider} label={provider}>
              {providerModels.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {modelLabel(m)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !wsUrl}
          className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
          title="Refresh model list"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
      {!error && models.length > 0 && (
        <p className="text-xs text-muted-foreground mt-1">
          {models.length} models from {Object.keys(providers).length} providers. Leave empty to use agent default.
        </p>
      )}
    </Field>
  );
}

function AgentSelector({
  wsUrl,
  token,
  value,
  onChange,
}: {
  wsUrl: string;
  token: string;
  value: string;
  onChange: (agentId: string) => void;
}) {
  const { agents, defaultId, loading, error, refresh } = useGatewayAgents(wsUrl, token);

  return (
    <Field label="OpenClaw agent">
      <div className="flex gap-1.5 items-center">
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className={selectClass + " flex-1"}
          disabled={loading}
        >
          <option value="">
            {loading ? "Fetching agents..." : agents.length === 0 ? "Enter gateway URL first" : "Select an agent"}
          </option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {agentLabel(a)}{a.id === defaultId ? " (default)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !wsUrl}
          className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
          title="Refresh agent list"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {error && (
        <p className="text-xs text-destructive mt-1">{error}</p>
      )}
      {!error && agents.length > 0 && (
        <p className="text-xs text-muted-foreground mt-1">
          {agents.length} agent{agents.length !== 1 ? "s" : ""} available. Each agent gets isolated session handling.
        </p>
      )}
    </Field>
  );
}

export function OpenClawGatewayConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const configuredHeaders =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "headers", configuredHeaders) as Record<string, unknown>) ?? {};

  const effectiveGatewayToken = typeof effectiveHeaders["x-openclaw-token"] === "string"
    ? String(effectiveHeaders["x-openclaw-token"])
    : typeof effectiveHeaders["x-openclaw-auth"] === "string"
      ? String(effectiveHeaders["x-openclaw-auth"])
      : "";

  const commitGatewayToken = (rawValue: string) => {
    const nextValue = rawValue.trim();
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    if (nextValue) {
      nextHeaders["x-openclaw-token"] = nextValue;
      delete nextHeaders["x-openclaw-auth"];
    } else {
      delete nextHeaders["x-openclaw-token"];
      delete nextHeaders["x-openclaw-auth"];
    }
    mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
  };

  const sessionStrategy = isCreate
    ? String((values as unknown as Record<string, unknown>)?.openclawSessionStrategy ?? "project")
    : eff(
        "adapterConfig",
        "sessionKeyStrategy",
        String(config.sessionKeyStrategy ?? config.sessionStrategy ?? "project"),
      );

  // Resolve the gateway URL and token for agent fetching
  const rawUrl = isCreate
    ? (values?.url ?? "")
    : String(eff("adapterConfig", "url", String(config.url ?? "")));
  const wsUrl = rawUrl.replace(/^http/, "ws");
  const wsToken = isCreate
    ? String((values as unknown as Record<string, unknown>)?.token ?? "")
    : effectiveGatewayToken;

  // Agent ID: in create mode stored as extra form value, in edit mode in adapterConfig
  const currentAgentId = isCreate
    ? String((values as unknown as Record<string, unknown>)?.openclawAgentId ?? "")
    : String(eff("adapterConfig", "agentId", String(config.agentId ?? "")));

  // Model override
  const currentModel = isCreate
    ? String((values as unknown as Record<string, unknown>)?.openclawModel ?? "")
    : String(eff("adapterConfig", "model", String(config.model ?? "")));

  // Thinking level
  const currentThinking = isCreate
    ? String((values as unknown as Record<string, unknown>)?.openclawThinking ?? "")
    : String(eff("adapterConfig", "thinking", String(config.thinking ?? "")));

  return (
    <>
      <Field label="Gateway URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://127.0.0.1:18789"
        />
      </Field>

      {isCreate ? (
        <SecretField
          label="Gateway auth token (x-openclaw-token)"
          value={String((values as unknown as Record<string, unknown>)?.token ?? "")}
          onCommit={(v) => set!({ token: v } as Partial<typeof values & { token: string }>)}
          placeholder="OpenClaw gateway token"
        />
      ) : (
        <SecretField
          label="Gateway auth token (x-openclaw-token)"
          value={effectiveGatewayToken}
          onCommit={commitGatewayToken}
          placeholder="OpenClaw gateway token"
        />
      )}

      <AgentSelector
        wsUrl={wsUrl}
        token={wsToken}
        value={currentAgentId}
        onChange={(agentId) =>
          isCreate
            ? set!({ openclawAgentId: agentId } as Partial<typeof values & { openclawAgentId: string }>)
            : mark("adapterConfig", "agentId", agentId || undefined)
        }
      />

      <ModelSelector
        wsUrl={wsUrl}
        token={wsToken}
        value={currentModel}
        onChange={(model) =>
          isCreate
            ? set!({ openclawModel: model } as Partial<typeof values & { openclawModel: string }>)
            : mark("adapterConfig", "model", model || undefined)
        }
      />

      <Field label="Thinking level">
        <select
          value={currentThinking || ""}
          onChange={(e) =>
            isCreate
              ? set!({ openclawThinking: e.target.value } as Partial<typeof values & { openclawThinking: string }>)
              : mark("adapterConfig", "thinking", e.target.value || undefined)
          }
          className={selectClass}
        >
          <option value="">Default (agent decides)</option>
          <option value="off">Off</option>
          <option value="minimal">Minimal</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="adaptive">Adaptive (Claude 4.6+)</option>
          <option value="xhigh">Extra High</option>
        </select>
        <p className="text-xs text-muted-foreground mt-1">
          Controls reasoning depth. Adaptive and xHigh are model-restricted — mismatches will error.
        </p>
      </Field>

      <Field label="Session strategy">
        <select
          value={sessionStrategy}
          onChange={(e) =>
            isCreate
              ? set!({ openclawSessionStrategy: e.target.value } as Partial<typeof values & { openclawSessionStrategy: string }>)
              : mark("adapterConfig", "sessionKeyStrategy", e.target.value)
          }
          className={selectClass}
        >
          <option value="project">Per project (recommended)</option>
          <option value="issue">Per issue</option>
          <option value="fixed">Fixed</option>
          <option value="run">Per run</option>
        </select>
        <p className="text-xs text-muted-foreground mt-1.5">
          {sessionStrategy === "project" && "Issues in the same project share one session. Agent builds context across tasks but runs are serialized — concurrent issues queue up."}
          {sessionStrategy === "issue" && "Each issue gets its own session. Parallel execution with isolated context per task."}
          {sessionStrategy === "fixed" && "All issues share a single session. Maximum context retention but fully serialized execution. Best for single-purpose agents."}
          {sessionStrategy === "run" && "Fresh session for every run. No shared context, maximum parallelism. Best for stateless one-shot tasks."}
        </p>
      </Field>

      {sessionStrategy === "fixed" && !isCreate && (
        <Field label="Session key">
          <DraftInput
            value={eff("adapterConfig", "sessionKey", String(config.sessionKey ?? "paperclip"))}
            onCommit={(v) => mark("adapterConfig", "sessionKey", v || undefined)}
            immediate
            className={inputClass}
            placeholder="paperclip"
          />
        </Field>
      )}

      <Field label="Prompt template" hint={help.promptTemplate}>
        <MarkdownEditor
          value={
            isCreate
              ? (values!.promptTemplate ?? "")
              : eff("adapterConfig", "promptTemplate", String(config.promptTemplate ?? ""))
          }
          onChange={(v) =>
            isCreate
              ? set!({ promptTemplate: v })
              : mark("adapterConfig", "promptTemplate", v ?? "")
          }
          placeholder="You are {{ agent.name }}. Your role is to..."
          contentClassName="min-h-[88px] text-sm font-mono"
        />
      </Field>
      <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
        Prompt template is injected once per session (hash-based dedup). Supports <code className="bg-amber-900/30 px-1 rounded">{"{{ agent.name }}"}</code>, <code className="bg-amber-900/30 px-1 rounded">{"{{ agent.id }}"}</code>, <code className="bg-amber-900/30 px-1 rounded">{"{{ context.* }}"}</code> and other template variables.
      </div>

      <div>
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-start gap-2 mb-2">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <strong>Deprecated.</strong> New adapter features (agent selector, model override, thinking, session strategy, prompt template) are bypassed when a payload template is present. Clear to use new configuration fields.
          </div>
        </div>
        <PayloadTemplateJsonField
          isCreate={isCreate}
          values={values}
          set={set}
          config={config}
          mark={mark}
        />
      </div>

      <RuntimeServicesJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />

      {!isCreate && (
        <>
          <Field label="Paperclip API URL override">
            <DraftInput
              value={
                eff(
                  "adapterConfig",
                  "paperclipApiUrl",
                  String(config.paperclipApiUrl ?? ""),
                )
              }
              onCommit={(v) => mark("adapterConfig", "paperclipApiUrl", v || undefined)}
              immediate
              className={inputClass}
              placeholder="https://paperclip.example"
            />
          </Field>

          <Field label="Role">
            <DraftInput
              value={eff("adapterConfig", "role", String(config.role ?? "operator"))}
              onCommit={(v) => mark("adapterConfig", "role", v || undefined)}
              immediate
              className={inputClass}
              placeholder="operator"
            />
          </Field>

          <Field label="Scopes (comma-separated)">
            <DraftInput
              value={eff("adapterConfig", "scopes", parseScopes(config.scopes ?? ["operator.admin"]))}
              onCommit={(v) => {
                const parsed = v
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter(Boolean);
                mark("adapterConfig", "scopes", parsed.length > 0 ? parsed : undefined);
              }}
              immediate
              className={inputClass}
              placeholder="operator.admin"
            />
          </Field>

          <Field label="Wait timeout (ms)">
            <DraftInput
              value={eff("adapterConfig", "waitTimeoutMs", String(config.waitTimeoutMs ?? "120000"))}
              onCommit={(v) => {
                const parsed = Number.parseInt(v.trim(), 10);
                mark(
                  "adapterConfig",
                  "waitTimeoutMs",
                  Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
                );
              }}
              immediate
              className={inputClass}
              placeholder="120000"
            />
          </Field>

          <Field label="Device auth">
            <div className="text-xs text-muted-foreground leading-relaxed">
              Always enabled for gateway agents. Paperclip persists a device key during onboarding so pairing approvals
              remain stable across runs.
            </div>
          </Field>
        </>
      )}
    </>
  );
}
