import { useRef, useState } from "react";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConnectionCatalog } from "./ConnectionCatalog";
import { RoutingAccess } from "./RoutingAccess";
import { ConnectionSetup } from "./ConnectionSetup";
import {
  AdvancedOptions,
  Choice,
  Footer,
  Notice,
  Surface,
  TextField,
} from "./shared";
import {
  connections,
  formatLabels,
  isAdvancedProvider,
  type Connection,
} from "./model";

export function Management({
  initialView = "list",
  initialTab = "details",
  readOnly = false,
  includeAdvancedConnections = false,
}: {
  initialView?: "list" | "details";
  initialTab?: "details" | "models" | "access";
  readOnly?: boolean;
  includeAdvancedConnections?: boolean;
}) {
  const [rows, setRows] = useState(
    initialView === "details" || includeAdvancedConnections
      ? connections
      : connections.filter(
          (connection) => !isAdvancedProvider(connection.provider),
        ),
  );
  const [selected, setSelected] = useState<Connection | undefined>(
    initialView === "details" ? connections[4] : undefined,
  );
  const [adding, setAdding] = useState(false);
  const [addingProvider, setAddingProvider] =
    useState<Connection["provider"]>();
  const [tab, setTab] = useState(initialTab);
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("Engineering gateway");
  const [alias, setAlias] = useState("");
  const [context, setContext] = useState("128000");
  const [helper, setHelper] = useState("engineering-fast");
  const [models, setModels] = useState([
    "engineering-coder",
    "engineering-fast",
  ]);
  const [agents, setAgents] = useState("all");
  const [rotate, setRotate] = useState(false);
  const [credential, setCredential] = useState("");
  const [revoke, setRevoke] = useState(false);
  const [contextWindows, setContextWindows] = useState<Record<string, string>>({
    "engineering-coder": "128000",
    "engineering-fast": "128000",
  });
  const [preferences, setPreferences] = useState<
    Record<
      string,
      {
        helper: string;
        agents: string;
        contextWindows: Record<string, string>;
      }
    >
  >({});
  const rotateTrigger = useRef<HTMLButtonElement>(null);
  const revokeTrigger = useRef<HTMLButtonElement>(null);

  const open = (connection: Connection) => {
    const saved = preferences[connection.id];
    setSelected(connection);
    setName(connection.name);
    setModels(connection.models);
    setHelper(saved?.helper ?? connection.models.at(-1)!);
    setAgents(saved?.agents ?? "all");
    setContextWindows(
      saved?.contextWindows ??
        Object.fromEntries(connection.models.map((model) => [model, "128000"])),
    );
    setAlias("");
    setTab("details");
    setNotice("");
  };
  const save = () => {
    if (!selected) return;
    const next = { ...selected, name, models };
    setPreferences((current) => ({
      ...current,
      [next.id]: { helper, agents, contextWindows },
    }));
    setSelected(next);
    setRows((current) =>
      current.map((row) => (row.id === next.id ? next : row)),
    );
    setNotice("Connection settings saved.");
  };
  if (adding)
    return (
      <ConnectionSetup
        initialProvider={addingProvider ?? selected?.provider}
        initialStep={selected || addingProvider ? "access" : "provider"}
        onCancel={() => setAdding(false)}
        onComplete={(connection) => {
          setRows((current) => [
            ...current.filter((row) => row.id !== connection.id),
            connection,
          ]);
          setAdding(false);
          open(connection);
        }}
      />
    );
  if (!selected)
    return (
      <Surface
        title="Connectors"
        description="Manage the accounts your agents use."
      >
        <Button
          className="self-start"
          disabled={readOnly}
          onClick={() => setAdding(true)}
        >
          <Plus />
          Add connection
        </Button>
        <ConnectionCatalog
          rows={rows}
          onOpen={open}
          readOnly={readOnly}
          onAdd={(provider) => {
            setAddingProvider(provider);
            setAdding(true);
          }}
          onRemove={(id) =>
            setRows((current) => current.filter((row) => row.id !== id))
          }
        />
      </Surface>
    );
  return (
    <Surface
      title={selected.name}
      description={`${selected.ownership === "shared" ? "Company connection" : "Personal connection"} · ${selected.status === "connected" ? "Connected" : "Credential revoked"}`}
    >
      <Button
        variant="ghost"
        className="self-start"
        onClick={() => setSelected(undefined)}
      >
        <ArrowLeft />
        Connectors
      </Button>
      <nav aria-label="Connection settings" className="flex flex-wrap gap-2">
        {(["details", "models", "access"] as const).map((item) => (
          <Button
            key={item}
            size="sm"
            variant={tab === item ? "secondary" : "ghost"}
            aria-pressed={tab === item}
            onClick={() => {
              setTab(item);
              setNotice("");
            }}
          >
            {item === "details"
              ? "Connection"
              : item === "models"
                ? "Models"
                : "Access"}
          </Button>
        ))}
      </nav>
      {tab === "details" ? (
        <>
          <TextField
            label="Connection name"
            value={name}
            disabled={readOnly}
            onChange={(event) => setName(event.target.value)}
          />
          <p className="text-sm text-muted-foreground">
            {selected.method} ·{" "}
            {selected.status === "connected" ? "Connected" : "Revoked"}
          </p>
          <Button
            ref={rotateTrigger}
            variant="outline"
            className="self-start"
            disabled={readOnly}
            onClick={() => setRotate(true)}
          >
            Replace credential
          </Button>
          <AdvancedOptions label="Advanced connection settings">
            <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <dt className="text-muted-foreground">Destination</dt>
              <dd className="break-all font-mono text-xs">
                {selected.endpoint}
              </dd>
              <dt className="text-muted-foreground">API format</dt>
              <dd>
                {selected.protocols
                  .map((format) => formatLabels[format])
                  .join(", ")}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="ghost"
                disabled={readOnly}
                onClick={() => setAdding(true)}
              >
                Use a different endpoint
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A different endpoint creates a separate connection. Nova and Atlas
              keep their current destination until you select the new connection
              for them.
            </p>
          </AdvancedOptions>
          {selected.id === "gateway" && (
            <details className="text-sm">
              <summary className="cursor-pointer">Used by 2 agents</summary>
              <ul className="mt-3 space-y-2 text-muted-foreground">
                <li>Nova · Codex · engineering-coder</li>
                <li>Atlas · OpenCode · engineering-fast</li>
              </ul>
            </details>
          )}
        </>
      ) : tab === "models" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Add model IDs or gateway aliases this connection serves. Each agent
            chooses its own model.
          </p>
          <div className="flex flex-col gap-3">
            {models.map((model) => (
              <div
                key={model}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3"
              >
                <code className="break-all text-xs">{model}</code>
                <span className="text-xs text-muted-foreground">
                  {contextWindows[model] ?? "128000"} tokens · Streaming · Tools
                </span>
              </div>
            ))}
          </div>
          <TextField
            label="Model ID or alias"
            value={alias}
            disabled={readOnly}
            onChange={(event) => setAlias(event.target.value)}
            placeholder="team-reviewer"
          />
          <TextField
            label="Context window (tokens)"
            type="number"
            min={1}
            value={context}
            disabled={readOnly}
            onChange={(event) => setContext(event.target.value)}
            hint="Use the limit supplied by your provider for this alias."
          />
          <Button
            variant="outline"
            className="self-start"
            disabled={
              readOnly ||
              !alias.trim() ||
              !Number.isFinite(Number(context)) ||
              Number(context) <= 0 ||
              models.includes(alias.trim())
            }
            onClick={() => {
              setModels((current) => [...current, alias.trim()]);
              setContextWindows((current) => ({
                ...current,
                [alias.trim()]: context,
              }));
              setAlias("");
              setNotice(
                "Model added to this draft. Save changes to make it available.",
              );
            }}
          >
            Add model
          </Button>
          <Choice
            label="Default helper model"
            value={helper}
            disabled={readOnly}
            onChange={setHelper}
            options={models.map((model) => ({ value: model, label: model }))}
          />
          <p className="text-xs text-muted-foreground">
            Used for titles and other auxiliary requests when supported by the
            harness. Keeps those requests on this connection.
          </p>
        </>
      ) : (
        <>
          <RoutingAccess
            ownership={selected.ownership}
            onOwnershipChange={() => {}}
            fixedOwnership
            agentIds={
              agents === "all" ? new Set<string>() : new Set(agents.split(","))
            }
            onAgentIdsChange={(ids) => setAgents([...ids].join(","))}
            allAgents={agents === "all"}
            onAllAgentsChange={(all) => setAgents(all ? "all" : "nova")}
            disabled={readOnly}
            hideFooter
          />
          <Notice>
            Personal credentials are resolved for this destination. A user’s
            default account does not replace a credential for {selected.name}.
          </Notice>
          <Button
            ref={revokeTrigger}
            variant="outline"
            className="self-start"
            disabled={readOnly || selected.status === "expired"}
            onClick={() => setRevoke(true)}
          >
            Revoke credential
          </Button>
        </>
      )}
      {readOnly && (
        <p className="text-sm text-muted-foreground">
          Only the connection owner can edit these settings.
        </p>
      )}
      {notice && <Notice>{notice}</Notice>}
      <Footer
        back="Cancel"
        onBack={() => {
          setSelected(undefined);
          setNotice("");
        }}
        next="Save changes"
        onNext={save}
        disabled={readOnly || !name.trim()}
      />
      <Dialog
        open={rotate}
        onOpenChange={(open) => {
          setRotate(open);
          if (!open) setCredential("");
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            rotateTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Replace credential</DialogTitle>
            <DialogDescription>
              {selected.name} · {selected.endpoint}. The destination and agent
              models stay the same.
            </DialogDescription>
          </DialogHeader>
          {selected.method === "Subscription" ? (
            <p className="text-sm text-muted-foreground">
              Sign in again to replace this subscription credential.
            </p>
          ) : (
            <TextField
              label="New API key"
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoComplete="off"
            />
          )}
          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              onClick={() => {
                setRotate(false);
                setCredential("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={
                selected.method !== "Subscription" && !credential.trim()
              }
              onClick={() => {
                const next = { ...selected, status: "connected" as const };
                setSelected(next);
                setRows((current) =>
                  current.map((row) => (row.id === next.id ? next : row)),
                );
                setCredential("");
                setRotate(false);
                setNotice("Credential replaced. New runs will use it.");
              }}
            >
              {selected.method === "Subscription"
                ? "Sign in"
                : "Replace credential"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={revoke} onOpenChange={setRevoke}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            revokeTrigger.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Revoke this credential?</DialogTitle>
            <DialogDescription>
              Agents using this connection will need a valid credential before
              their next run. Their selected connection will stay the same.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button variant="ghost" onClick={() => setRevoke(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const next = { ...selected, status: "expired" as const };
                setSelected(next);
                setRows((current) =>
                  current.map((row) => (row.id === next.id ? next : row)),
                );
                setRevoke(false);
                setNotice(
                  "Credential revoked. Reconnect to use this connection again.",
                );
              }}
            >
              Revoke credential
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Surface>
  );
}
