import { useState } from "react";
import type {
  CompanySecret,
  EnvBinding,
  McpServerAuth,
  McpServerConfig,
  McpServersConfig,
  McpTransport,
  SecretVersionSelector,
} from "@paperclipai/shared";
import { MCP_SERVER_NAME_RE } from "@paperclipai/shared";
import { ChevronDown, Lock, Pencil, Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";

/**
 * Local adapter types that support external MCP server injection. Used by
 * AgentConfigForm to decide whether to render the MCP Servers section.
 */
export const MCP_CAPABLE_ADAPTER_TYPES = new Set<string>([
  "claude_local",
  "claude_tui",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
]);

/** Mirrors the cap enforced by the shared mcpServersConfigSchema validator. */
const MAX_MCP_SERVERS = 32;

/** Sentinel the API substitutes for plain sensitive values on read. */
const REDACTED_SENTINEL = "***REDACTED***";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const transportOptions: { id: McpTransport; label: string; hint: string }[] = [
  { id: "stdio", label: "stdio", hint: "Local process spawned alongside the agent" },
  { id: "http", label: "http", hint: "Remote streamable HTTP endpoint" },
  { id: "sse", label: "sse", hint: "Remote server-sent events endpoint" },
];

/* ---- Binding rows (plain-vs-secret pattern shared with EnvVarEditor) ---- */

type BindingRow = {
  key: string;
  source: "plain" | "secret";
  plainValue: string;
  secretId: string;
  version: SecretVersionSelector;
  /** True when the API returned a redacted plain value that has not been re-entered. */
  locked: boolean;
};

function emptyBindingRow(): BindingRow {
  return { key: "", source: "plain", plainValue: "", secretId: "", version: "latest", locked: false };
}

function bindingToRow(key: string, binding: EnvBinding): BindingRow {
  if (typeof binding === "string") {
    const locked = binding === REDACTED_SENTINEL;
    return {
      key,
      source: "plain",
      plainValue: locked ? "" : binding,
      secretId: "",
      version: "latest",
      locked,
    };
  }
  if (binding && typeof binding === "object" && binding.type === "secret_ref") {
    return {
      key,
      source: "secret",
      plainValue: "",
      secretId: binding.secretId,
      version: binding.version ?? "latest",
      locked: false,
    };
  }
  if (binding && typeof binding === "object" && binding.type === "plain") {
    const locked = binding.value === REDACTED_SENTINEL;
    return {
      key,
      source: "plain",
      plainValue: locked ? "" : binding.value,
      secretId: "",
      version: "latest",
      locked,
    };
  }
  return { key, source: "plain", plainValue: "", secretId: "", version: "latest", locked: false };
}

function toBindingRows(rec: Record<string, EnvBinding> | undefined): BindingRow[] {
  const rows = Object.entries(rec ?? {}).map(([key, binding]) => bindingToRow(key, binding));
  return [...rows, emptyBindingRow()];
}

function ensureTrailingRow(rows: BindingRow[]): BindingRow[] {
  const last = rows[rows.length - 1];
  if (!last || last.key || last.plainValue || last.secretId || last.locked) {
    return [...rows, emptyBindingRow()];
  }
  return rows;
}

function rowToBinding(row: BindingRow): EnvBinding {
  if (row.source === "secret" && row.secretId) {
    return { type: "secret_ref", secretId: row.secretId, version: row.version };
  }
  return { type: "plain", value: row.plainValue };
}

function rowsToRecord(rows: BindingRow[]): Record<string, EnvBinding> | undefined {
  const rec: Record<string, EnvBinding> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    rec[key] = rowToBinding(row);
  }
  return Object.keys(rec).length > 0 ? rec : undefined;
}

function hasLockedRow(rows: BindingRow[]): boolean {
  return rows.some((row) => row.locked);
}

function defaultSecretName(key: string) {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" || url.protocol === "https:";
}

function serverSummary(server: McpServerConfig): string {
  if (server.transport === "stdio") {
    return [server.command, ...(server.args ?? [])].join(" ").trim();
  }
  return server.url;
}

/**
 * Brokered-OAuth connection state for a remote server, or null when the server
 * does not use OAuth auth. The API's sanitized GET response adds a `connected`
 * boolean next to `secretId`; both signals are honored.
 */
function oauthConnectionState(server: McpServerConfig): { connected: boolean } | null {
  if (server.transport === "stdio") return null;
  const auth = server.auth;
  if (!auth || auth.type !== "oauth") return null;
  const connected =
    (typeof auth.secretId === "string" && auth.secretId.length > 0) ||
    (auth as { connected?: boolean }).connected === true;
  return { connected };
}

const connectedBadgeClass =
  "shrink-0 text-[10px] text-green-700 dark:text-green-300 border-green-300 dark:border-green-500/40 bg-green-50 dark:bg-green-500/10";

/* ---- Editor ---- */

export function McpServersEditor({
  value,
  secrets,
  onCreateSecret,
  onChange,
  onStartOauth,
}: {
  value: McpServersConfig | null | undefined;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onChange: (mcpServers: McpServersConfig | undefined) => void;
  /**
   * Starts the Paperclip-brokered OAuth flow for a saved http/sse server. The
   * caller is responsible for hitting the API and opening the authorize URL
   * (e.g. agentsApi.startMcpOauth + window.open). Optional so the editor stays
   * usable without network access (create flows, showcases).
   */
  onStartOauth?: (serverName: string) => Promise<void>;
}) {
  const servers: McpServersConfig = value && typeof value === "object" ? value : {};
  const entries = Object.entries(servers);
  const [editor, setEditor] = useState<{ mode: "add" } | { mode: "edit"; name: string } | null>(null);
  const [oauthPendingName, setOauthPendingName] = useState<string | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);

  async function startOauth(name: string) {
    if (!onStartOauth) return;
    setOauthPendingName(name);
    setOauthError(null);
    try {
      await onStartOauth(name);
    } catch (error) {
      setOauthError(error instanceof Error ? error.message : "Failed to start OAuth connection");
    } finally {
      setOauthPendingName(null);
    }
  }

  function emit(next: McpServersConfig) {
    onChange(Object.keys(next).length > 0 ? next : undefined);
  }

  /**
   * Replace/add a single server. Untouched entries pass through by reference,
   * so redacted values inside servers the user did not edit are never rewritten.
   */
  function commitServer(originalName: string | null, name: string, server: McpServerConfig) {
    const next: McpServersConfig = {};
    let replaced = false;
    for (const [key, existing] of entries) {
      if (originalName !== null && key === originalName) {
        next[name] = server;
        replaced = true;
        continue;
      }
      next[key] = existing;
    }
    if (!replaced) next[name] = server;
    emit(next);
    setEditor(null);
  }

  function removeServer(name: string) {
    const next: McpServersConfig = {};
    for (const [key, existing] of entries) {
      if (key === name) continue;
      next[key] = existing;
    }
    emit(next);
    if (editor?.mode === "edit" && editor.name === name) setEditor(null);
  }

  function setServerEnabled(name: string, enabled: boolean) {
    const server = servers[name];
    if (!server) return;
    emit({ ...servers, [name]: { ...server, enabled } });
  }

  return (
    <div className="space-y-1.5">
      {entries.length === 0 && editor?.mode !== "add" && (
        <p className="text-[11px] text-muted-foreground/60">No MCP servers configured.</p>
      )}
      {entries.length > 0 && (
        <div className="rounded-md border border-border divide-y divide-border">
          {entries.map(([name, server]) =>
            editor?.mode === "edit" && editor.name === name ? (
              <ServerForm
                key={name}
                originalName={name}
                initial={server}
                takenNames={entries.map(([existingName]) => existingName)}
                secrets={secrets}
                onCreateSecret={onCreateSecret}
                onStartOauth={onStartOauth}
                onCancel={() => setEditor(null)}
                onSubmit={(nextName, nextServer) => commitServer(name, nextName, nextServer)}
              />
            ) : (
              <div key={name} className="flex items-center gap-2 px-3 py-2">
                <span
                  className={cn(
                    "font-mono text-sm truncate",
                    server.enabled === false && "text-muted-foreground",
                  )}
                >
                  {name}
                </span>
                <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                  {server.transport}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {serverSummary(server)}
                </span>
                {(() => {
                  const oauth = oauthConnectionState(server);
                  if (!oauth) return null;
                  if (oauth.connected) {
                    return (
                      <>
                        <Badge variant="outline" className={connectedBadgeClass}>
                          Connected
                        </Badge>
                        {onStartOauth && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            className="shrink-0"
                            disabled={oauthPendingName === name}
                            onClick={() => void startOauth(name)}
                          >
                            {oauthPendingName === name ? "Opening..." : "Reconnect"}
                          </Button>
                        )}
                      </>
                    );
                  }
                  if (onStartOauth) {
                    return (
                      <Button
                        type="button"
                        size="xs"
                        className="shrink-0"
                        disabled={oauthPendingName === name}
                        onClick={() => void startOauth(name)}
                      >
                        {oauthPendingName === name ? "Opening..." : "Connect"}
                      </Button>
                    );
                  }
                  return (
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      OAuth
                    </Badge>
                  );
                })()}
                <ToggleSwitch
                  checked={server.enabled !== false}
                  onCheckedChange={(enabled) => setServerEnabled(name, enabled)}
                  aria-label={`Toggle ${name}`}
                />
                <button
                  type="button"
                  className="shrink-0 p-1 rounded hover:bg-accent/50 text-muted-foreground hover:text-foreground transition-colors"
                  title={`Edit ${name}`}
                  onClick={() => setEditor({ mode: "edit", name })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                  title={`Remove ${name}`}
                  onClick={() => removeServer(name)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ),
          )}
        </div>
      )}
      {editor?.mode === "add" ? (
        <div className="rounded-md border border-border">
          <ServerForm
            originalName={null}
            initial={null}
            takenNames={entries.map(([existingName]) => existingName)}
            secrets={secrets}
            onCreateSecret={onCreateSecret}
            onStartOauth={onStartOauth}
            onCancel={() => setEditor(null)}
            onSubmit={(name, server) => commitServer(null, name, server)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          onClick={() => setEditor({ mode: "add" })}
          disabled={entries.length >= MAX_MCP_SERVERS}
        >
          <Plus className="h-3.5 w-3.5" />
          Add MCP server
        </button>
      )}
      {oauthError && <p className="text-[11px] text-destructive">{oauthError}</p>}
      {entries.length >= MAX_MCP_SERVERS && (
        <p className="text-[11px] text-muted-foreground/60">
          At most {MAX_MCP_SERVERS} MCP servers per agent.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground/60">
        External MCP servers are injected into this agent&apos;s runtime at spawn time. Use secret
        references for tokens and API keys instead of plain values.
      </p>
    </div>
  );
}

/* ---- Add/edit form ---- */

function ServerForm({
  originalName,
  initial,
  takenNames,
  secrets,
  onCreateSecret,
  onStartOauth,
  onCancel,
  onSubmit,
}: {
  originalName: string | null;
  initial: McpServerConfig | null;
  takenNames: string[];
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  onStartOauth?: (serverName: string) => Promise<void>;
  onCancel: () => void;
  onSubmit: (name: string, server: McpServerConfig) => void;
}) {
  const initialStdio = initial?.transport === "stdio" ? initial : null;
  const initialRemote = initial && initial.transport !== "stdio" ? initial : null;
  const initialAuth = initialRemote?.auth;

  const [name, setName] = useState(originalName ?? "");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "stdio");
  const [transportOpen, setTransportOpen] = useState(false);

  const [command, setCommand] = useState(initialStdio?.command ?? "");
  const [argsText, setArgsText] = useState((initialStdio?.args ?? []).join("\n"));
  const [cwd, setCwd] = useState(initialStdio?.cwd ?? "");
  const [envRows, setEnvRows] = useState<BindingRow[]>(() => toBindingRows(initialStdio?.env));

  const [url, setUrl] = useState(initialRemote?.url ?? "");
  const [headerRows, setHeaderRows] = useState<BindingRow[]>(() =>
    toBindingRows(initialRemote?.headers),
  );
  const [authMode, setAuthMode] = useState<"none" | "bearer" | "oauth">(initialAuth?.type ?? "none");
  const [bearerToken, setBearerToken] = useState<BindingRow>(() =>
    initialAuth?.type === "bearer" ? bindingToRow("", initialAuth.token) : emptyBindingRow(),
  );
  const [bearerSealError, setBearerSealError] = useState<string | null>(null);
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const initialOauth = initial ? oauthConnectionState(initial) : null;
  const canConnectOauth = Boolean(onStartOauth && originalName && initialAuth?.type === "oauth");

  async function startOauthFromForm() {
    if (!onStartOauth || !originalName) return;
    setOauthPending(true);
    setOauthError(null);
    try {
      await onStartOauth(originalName);
    } catch (error) {
      setOauthError(error instanceof Error ? error.message : "Failed to start OAuth connection");
    } finally {
      setOauthPending(false);
    }
  }

  const trimmedName = name.trim();
  const nameValid = MCP_SERVER_NAME_RE.test(trimmedName);
  const nameTaken = takenNames.includes(trimmedName) && trimmedName !== originalName;
  const isStdio = transport === "stdio";
  const commandMissing = isStdio && command.trim().length === 0;
  const urlInvalid = !isStdio && !isHttpUrl(url.trim());
  const lockedRemaining = isStdio
    ? hasLockedRow(envRows)
    : hasLockedRow(headerRows) || (authMode === "bearer" && bearerToken.locked);
  const canSave =
    trimmedName.length > 0 &&
    nameValid &&
    !nameTaken &&
    !commandMissing &&
    !urlInvalid &&
    !lockedRemaining;

  function buildServer(): McpServerConfig {
    // Preserve fields this form does not edit (enabled, timeoutMs, allowedTools).
    const shared = {
      ...(initial?.enabled === false ? { enabled: false } : {}),
      ...(initial?.timeoutMs !== undefined ? { timeoutMs: initial.timeoutMs } : {}),
      ...(initial?.allowedTools !== undefined ? { allowedTools: initial.allowedTools } : {}),
    };
    if (transport === "stdio") {
      const args = argsText
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const env = rowsToRecord(envRows);
      return {
        ...shared,
        transport: "stdio",
        command: command.trim(),
        ...(args.length > 0 ? { args } : {}),
        ...(env ? { env } : {}),
        ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
      };
    }
    const headers = rowsToRecord(headerRows);
    // OAuth auth is rebuilt from scratch: the sanitized GET response adds a
    // `connected` field that the strict shared schema would reject on write.
    const auth: McpServerAuth | undefined =
      authMode === "bearer"
        ? { type: "bearer", token: rowToBinding(bearerToken) }
        : authMode === "oauth"
          ? initialAuth?.type === "oauth"
            ? {
                type: "oauth",
                secretId: initialAuth.secretId,
                ...(initialAuth.version !== undefined ? { version: initialAuth.version } : {}),
              }
            : { type: "oauth", secretId: null }
          : undefined;
    return {
      ...shared,
      transport,
      url: url.trim(),
      ...(headers ? { headers } : {}),
      ...(auth ? { auth } : {}),
    };
  }

  async function sealBearerToken() {
    const plain = bearerToken.plainValue;
    if (!plain) return;
    const suggested = defaultSecretName(trimmedName ? `${trimmedName}_token` : "mcp_token") || "secret";
    const secretName = window.prompt("Secret name", suggested)?.trim();
    if (!secretName) return;
    try {
      setBearerSealError(null);
      const created = await onCreateSecret(secretName, plain);
      setBearerToken((prev) => ({ ...prev, source: "secret", secretId: created.id }));
    } catch (error) {
      setBearerSealError(error instanceof Error ? error.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-3 bg-muted/20 px-3 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          <input
            className={inputClass}
            placeholder="e.g. github"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {trimmedName.length > 0 && !nameValid && (
            <p className="mt-1 text-[11px] text-destructive">
              Names must start with a letter and use only letters, digits, &apos;-&apos; and
              &apos;_&apos; (max 64 chars).
            </p>
          )}
          {nameTaken && (
            <p className="mt-1 text-[11px] text-destructive">
              A server named &quot;{trimmedName}&quot; already exists.
            </p>
          )}
        </FormField>
        <FormField label="Transport">
          <TransportDropdown
            value={transport}
            onChange={setTransport}
            open={transportOpen}
            onOpenChange={setTransportOpen}
          />
        </FormField>
      </div>

      {isStdio ? (
        <>
          <FormField label="Command">
            <input
              className={inputClass}
              placeholder="npx"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
            {commandMissing && command !== "" && (
              <p className="mt-1 text-[11px] text-destructive">Command is required.</p>
            )}
          </FormField>
          <FormField label="Arguments (one per line)">
            <textarea
              className={cn(inputClass, "resize-none")}
              rows={3}
              placeholder={"-y\n@modelcontextprotocol/server-github"}
              value={argsText}
              onChange={(event) => setArgsText(event.target.value)}
            />
          </FormField>
          <FormField label="Working directory (optional)">
            <input
              className={inputClass}
              placeholder="/path/to/project"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
            />
          </FormField>
          <FormField label="Environment variables">
            <BindingRowsEditor
              rows={envRows}
              onRowsChange={setEnvRows}
              secrets={secrets}
              onCreateSecret={onCreateSecret}
              keyPlaceholder="KEY"
            />
          </FormField>
        </>
      ) : (
        <>
          <FormField label="URL">
            <input
              className={inputClass}
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            {url.trim().length > 0 && urlInvalid && (
              <p className="mt-1 text-[11px] text-destructive">MCP server URLs must use http(s).</p>
            )}
          </FormField>
          <FormField label="Headers">
            <BindingRowsEditor
              rows={headerRows}
              onRowsChange={setHeaderRows}
              secrets={secrets}
              onCreateSecret={onCreateSecret}
              keyPlaceholder="Header-Name"
            />
          </FormField>
          <FormField label="Authentication">
            <select
              className={cn(inputClass, "bg-background")}
              value={authMode}
              onChange={(event) => setAuthMode(event.target.value as "none" | "bearer" | "oauth")}
            >
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="oauth">OAuth (Paperclip-brokered)</option>
            </select>
            {authMode === "bearer" && (
              <div className="mt-1.5 flex items-center gap-1.5">
                <BindingValueControls
                  row={bearerToken}
                  onPatch={(patch) => setBearerToken((prev) => ({ ...prev, ...patch }))}
                  onSeal={() => void sealBearerToken()}
                  sealDisabled={!bearerToken.plainValue}
                  secrets={secrets}
                  valuePlaceholder="token"
                />
              </div>
            )}
            {authMode === "bearer" && bearerSealError && (
              <p className="mt-1 text-[11px] text-destructive">{bearerSealError}</p>
            )}
            {authMode === "oauth" && (
              <div className="mt-1.5 space-y-1.5">
                {initialOauth?.connected ? (
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={connectedBadgeClass}>
                      Connected
                    </Badge>
                    {canConnectOauth && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        disabled={oauthPending}
                        onClick={() => void startOauthFromForm()}
                      >
                        {oauthPending ? "Opening..." : "Reconnect"}
                      </Button>
                    )}
                  </div>
                ) : canConnectOauth ? (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">Not connected</span>
                    <Button
                      type="button"
                      size="xs"
                      disabled={oauthPending}
                      onClick={() => void startOauthFromForm()}
                    >
                      {oauthPending ? "Opening..." : "Connect"}
                    </Button>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground/60">
                    Save this server, then use Connect to authorize it. Paperclip stores and
                    refreshes the token; the agent never sees an interactive login.
                  </p>
                )}
                {oauthError && <p className="text-[11px] text-destructive">{oauthError}</p>}
              </div>
            )}
          </FormField>
        </>
      )}

      {lockedRemaining && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Hidden values are locked. Re-enter (or remove) them before saving this server.
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!canSave}
          onClick={() => onSubmit(trimmedName, buildServer())}
        >
          {originalName ? "Save server" : "Add server"}
        </Button>
      </div>
    </div>
  );
}

/* ---- Form internals ---- */

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function TransportDropdown({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: McpTransport;
  onChange: (transport: McpTransport) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = transportOptions.find((option) => option.id === value);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between"
        >
          <span className="font-mono text-xs">{selected?.label ?? value}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-1" align="start">
        {transportOptions.map((option) => (
          <button
            key={option.id}
            type="button"
            className={cn(
              "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-accent/50",
              option.id === value && "bg-accent",
            )}
            onClick={() => {
              onChange(option.id);
              onOpenChange(false);
            }}
          >
            <span className="font-mono text-xs">{option.label}</span>
            <span className="text-[11px] text-muted-foreground">{option.hint}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Key/value binding rows with the plain-vs-secret picker pattern from
 * EnvVarEditor, plus locked placeholders for redacted values. Draft-managed by
 * the parent form; nothing is emitted until the server is saved.
 */
function BindingRowsEditor({
  rows,
  onRowsChange,
  secrets,
  onCreateSecret,
  keyPlaceholder,
}: {
  rows: BindingRow[];
  onRowsChange: (rows: BindingRow[]) => void;
  secrets: CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  keyPlaceholder: string;
}) {
  const [sealError, setSealError] = useState<string | null>(null);

  function updateRow(index: number, patch: Partial<BindingRow>) {
    const next = rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    onRowsChange(ensureTrailingRow(next));
  }

  function removeRow(index: number) {
    onRowsChange(ensureTrailingRow(rows.filter((_, rowIndex) => rowIndex !== index)));
  }

  async function sealRow(index: number) {
    const row = rows[index];
    if (!row) return;
    const key = row.key.trim();
    const plain = row.plainValue;
    if (!key || plain.length === 0) return;

    const suggested = defaultSecretName(key) || "secret";
    const secretName = window.prompt("Secret name", suggested)?.trim();
    if (!secretName) return;

    try {
      setSealError(null);
      const created = await onCreateSecret(secretName, plain);
      updateRow(index, { source: "secret", secretId: created.id });
    } catch (error) {
      setSealError(error instanceof Error ? error.message : "Failed to create secret");
    }
  }

  return (
    <div className="space-y-1.5">
      {rows.map((row, index) => {
        const isTrailing =
          index === rows.length - 1 && !row.key && !row.plainValue && !row.secretId && !row.locked;
        return (
          <div key={index} className="flex items-center gap-1.5">
            <input
              className={cn(inputClass, "flex-[2]")}
              placeholder={keyPlaceholder}
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
            />
            <BindingValueControls
              row={row}
              onPatch={(patch) => updateRow(index, patch)}
              onSeal={() => void sealRow(index)}
              sealDisabled={!row.key.trim() || !row.plainValue}
              secrets={secrets}
            />
            {!isTrailing ? (
              <button
                type="button"
                className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                onClick={() => removeRow(index)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            ) : (
              <div className="w-[26px] shrink-0" />
            )}
          </div>
        );
      })}
      {sealError && <p className="text-[11px] text-destructive">{sealError}</p>}
    </div>
  );
}

/** Value cell of a binding row: plain input, secret picker, or locked placeholder. */
function BindingValueControls({
  row,
  onPatch,
  onSeal,
  sealDisabled,
  secrets,
  valuePlaceholder = "value",
}: {
  row: BindingRow;
  onPatch: (patch: Partial<BindingRow>) => void;
  onSeal: () => void;
  sealDisabled: boolean;
  secrets: CompanySecret[];
  valuePlaceholder?: string;
}) {
  return (
    <>
      <select
        className={cn(inputClass, "flex-[1] bg-background")}
        value={row.source}
        onChange={(event) =>
          onPatch({
            source: event.target.value === "secret" ? "secret" : "plain",
            ...(event.target.value === "plain" ? { secretId: "" } : {}),
            ...(event.target.value === "secret" ? { locked: false } : {}),
          })
        }
      >
        <option value="plain">Plain</option>
        <option value="secret">Secret</option>
      </select>
      {row.source === "secret" ? (
        <>
          <select
            className={cn(
              inputClass,
              "flex-[3] bg-background",
              row.secretId &&
                !secrets.some((secret) => secret.id === row.secretId) &&
                "border-destructive text-destructive",
            )}
            value={row.secretId}
            onChange={(event) => onPatch({ secretId: event.target.value })}
          >
            <option value="">Select secret...</option>
            {row.secretId && !secrets.some((secret) => secret.id === row.secretId) ? (
              <option value={row.secretId}>Missing ({row.secretId.slice(0, 8)}…)</option>
            ) : null}
            {secrets.map((secret) => (
              <option key={secret.id} value={secret.id}>
                {secret.name}
                {secret.status !== "active" ? ` (${secret.status})` : ""}
              </option>
            ))}
          </select>
          <select
            className={cn(inputClass, "flex-[1] bg-background")}
            value={row.version === "latest" ? "latest" : String(row.version)}
            onChange={(event) => {
              const raw = event.target.value;
              onPatch({ version: raw === "latest" ? "latest" : Number.parseInt(raw, 10) });
            }}
            disabled={!row.secretId}
            aria-label="Version"
          >
            <option value="latest">latest</option>
            {(() => {
              const selected = secrets.find((secret) => secret.id === row.secretId);
              if (!selected) return null;
              return Array.from({ length: Math.max(0, selected.latestVersion) }, (_, idx) => {
                const version = selected.latestVersion - idx;
                if (version <= 0) return null;
                return (
                  <option key={version} value={version}>
                    v{version}
                  </option>
                );
              });
            })()}
          </select>
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
            onClick={onSeal}
            disabled={sealDisabled}
            title="Create secret from current plain value"
          >
            New
          </button>
        </>
      ) : row.locked ? (
        <div className="flex flex-[3] min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate font-mono text-xs text-muted-foreground">
            hidden — re-enter to change
          </span>
          <button
            type="button"
            className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/50 transition-colors"
            onClick={() => onPatch({ locked: false, plainValue: "" })}
          >
            Replace
          </button>
        </div>
      ) : (
        <>
          <input
            className={cn(inputClass, "flex-[3]")}
            placeholder={valuePlaceholder}
            value={row.plainValue}
            onChange={(event) => onPatch({ plainValue: event.target.value })}
          />
          <button
            type="button"
            className="inline-flex items-center rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 transition-colors shrink-0"
            onClick={onSeal}
            disabled={sealDisabled}
            title="Store value as secret and replace with reference"
          >
            Seal
          </button>
        </>
      )}
    </>
  );
}
