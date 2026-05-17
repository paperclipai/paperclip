import { useMemo, useState } from "react";
import {
  agentCapabilityMcpServerSchema,
  type AgentCapabilityMcpServer,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Transport = "stdio" | "streamable_http" | "sse";
type DesiredState = "enabled" | "disabled";

interface CustomMcpServerFormProps {
  existingServerIds: ReadonlySet<string>;
  onAdd: (server: AgentCapabilityMcpServer) => void;
}

type FieldErrors = Partial<
  Record<
    | "id"
    | "displayName"
    | "transport"
    | "command"
    | "remoteUrl"
    | "requiredSecretNames"
    | "desiredState"
    | "notes"
    | "form",
    string
  >
>;

function splitSecretNames(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function CustomMcpServerForm({ existingServerIds, onAdd }: CustomMcpServerFormProps) {
  const [id, setId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [requiredSecretNamesInput, setRequiredSecretNamesInput] = useState("");
  const [desiredState, setDesiredState] = useState<DesiredState>("enabled");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [lastAddedId, setLastAddedId] = useState<string | null>(null);

  const parsedSecretNames = useMemo(
    () => splitSecretNames(requiredSecretNamesInput),
    [requiredSecretNamesInput],
  );

  const resetForm = () => {
    setId("");
    setDisplayName("");
    setTransport("stdio");
    setCommand("");
    setRemoteUrl("");
    setRequiredSecretNamesInput("");
    setDesiredState("enabled");
    setNotes("");
    setErrors({});
  };

  const handleAdd = () => {
    setLastAddedId(null);
    const nextErrors: FieldErrors = {};

    const trimmedId = id.trim();
    if (!trimmedId) {
      nextErrors.id = "Capability id is required.";
    } else if (existingServerIds.has(trimmedId)) {
      nextErrors.id = `An MCP server with id "${trimmedId}" already exists in the draft.`;
    }

    const candidate: Record<string, unknown> = {
      id: trimmedId,
      provider: "manual",
      catalogId: null,
      displayName: displayName.trim(),
      transport,
      requiredSecretNames: parsedSecretNames,
      desiredState,
      liveState: "not_installed",
    };
    // Pass null when empty so the schema's optional/nullable path routes to the
    // superRefine messages ("stdio MCP servers must include a command" /
    // "remote MCP servers must include remoteUrl") instead of generic
    // string/url validators.
    const trimmedCommand = command.trim();
    const trimmedRemoteUrl = remoteUrl.trim();
    if (transport === "stdio") {
      candidate.command = trimmedCommand.length > 0 ? trimmedCommand : null;
      candidate.remoteUrl = null;
    } else {
      candidate.command = null;
      candidate.remoteUrl = trimmedRemoteUrl.length > 0 ? trimmedRemoteUrl : null;
    }
    const trimmedNotes = notes.trim();
    if (trimmedNotes.length > 0) candidate.notes = trimmedNotes;

    const result = agentCapabilityMcpServerSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const head = issue.path[0];
        const key =
          head === "id" ||
          head === "displayName" ||
          head === "transport" ||
          head === "command" ||
          head === "remoteUrl" ||
          head === "requiredSecretNames" ||
          head === "desiredState" ||
          head === "notes"
            ? head
            : "form";
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    // safeParse success path; cast through known type. Schema enforces all
    // safety contracts above (named secrets only, no raw secret values,
    // transport-specific required fields, liveState=not_installed).
    onAdd(result.data as AgentCapabilityMcpServer);
    setLastAddedId(trimmedId);
    resetForm();
  };

  return (
    <div className="space-y-3 rounded-md border border-dashed border-border bg-background/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Add a custom MCP server</p>
          <p className="text-xs text-muted-foreground">
            Desired config only — no live install, connect, execute, or external action happens when you add an
            entry here. Required secrets must reference environment-variable names; never paste raw API keys,
            tokens, passwords, or bearer strings.
          </p>
        </div>
        <span
          className="rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100"
          aria-label="Custom MCP form edits desired config only"
        >
          desired config only
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Capability id</span>
          <Input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="my-custom-mcp"
            aria-label="Custom MCP id"
            aria-invalid={Boolean(errors.id)}
          />
          {errors.id && <p className="text-xs text-destructive">{errors.id}</p>}
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Display name</span>
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="My custom MCP"
            aria-label="Custom MCP display name"
            aria-invalid={Boolean(errors.displayName)}
          />
          {errors.displayName && <p className="text-xs text-destructive">{errors.displayName}</p>}
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Transport</span>
          <select
            value={transport}
            onChange={(event) => setTransport(event.target.value as Transport)}
            aria-label="Custom MCP transport"
            className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
          >
            <option value="stdio">stdio</option>
            <option value="streamable_http">streamable_http</option>
            <option value="sse">sse</option>
          </select>
          {errors.transport && <p className="text-xs text-destructive">{errors.transport}</p>}
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">Desired state</span>
          <select
            value={desiredState}
            onChange={(event) => setDesiredState(event.target.value as DesiredState)}
            aria-label="Custom MCP desired state"
            className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs"
          >
            <option value="enabled">enabled</option>
            <option value="disabled">disabled</option>
          </select>
        </label>

        {transport === "stdio" ? (
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">
              Command <span className="text-[10px] uppercase tracking-wide">(required for stdio)</span>
            </span>
            <Input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npx -y @example/mcp-server"
              aria-label="Custom MCP command"
              aria-invalid={Boolean(errors.command)}
            />
            {errors.command && <p className="text-xs text-destructive">{errors.command}</p>}
          </label>
        ) : (
          <label className="block space-y-1 sm:col-span-2">
            <span className="text-xs font-medium text-muted-foreground">
              Remote URL <span className="text-[10px] uppercase tracking-wide">(required for {transport})</span>
            </span>
            <Input
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              placeholder="https://mcp.example.com/endpoint"
              aria-label="Custom MCP remote URL"
              aria-invalid={Boolean(errors.remoteUrl)}
            />
            {errors.remoteUrl && <p className="text-xs text-destructive">{errors.remoteUrl}</p>}
          </label>
        )}

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">
            Required named secrets
            <span className="ml-1 text-[10px] uppercase tracking-wide">(env identifiers, comma-separated)</span>
          </span>
          <Input
            value={requiredSecretNamesInput}
            onChange={(event) => setRequiredSecretNamesInput(event.target.value)}
            placeholder="MY_API_KEY, ANOTHER_TOKEN_NAME"
            aria-label="Custom MCP required secret names"
            aria-invalid={Boolean(errors.requiredSecretNames)}
          />
          <span className="text-[11px] text-muted-foreground">
            Names only — never paste raw API keys, tokens, passwords, or bearer strings here.
          </span>
          {parsedSecretNames.length > 0 && (
            <span className="text-[11px] text-muted-foreground">
              Parsed names: <span className="font-mono">{parsedSecretNames.join(", ")}</span>
            </span>
          )}
          {errors.requiredSecretNames && (
            <p className="text-xs text-destructive">{errors.requiredSecretNames}</p>
          )}
        </label>

        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Notes (optional)</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Operational notes — never paste raw secrets here."
            aria-label="Custom MCP notes"
            aria-invalid={Boolean(errors.notes)}
            className="min-h-[60px] w-full rounded-md border border-input bg-background p-2 text-sm shadow-xs"
          />
          {errors.notes && <p className="text-xs text-destructive">{errors.notes}</p>}
        </label>
      </div>

      {errors.form && (
        <p className="text-sm text-destructive">{errors.form}. No live action occurred.</p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Adding the entry only updates the draft. Use “Save desired config” to persist; live apply remains
          approval-gated.
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={resetForm}>
            Clear form
          </Button>
          <Button type="button" size="sm" onClick={handleAdd}>
            Add custom MCP to draft
          </Button>
        </div>
      </div>

      {lastAddedId && (
        <p className="text-xs text-emerald-700 dark:text-emerald-300" role="status">
          Added &quot;{lastAddedId}&quot; to the desired-config draft. Review the Advanced JSON fallback and save
          to persist.
        </p>
      )}
    </div>
  );
}
