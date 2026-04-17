import { useState, useEffect, useRef } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";
import { HintIcon } from "./agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-background outline-none text-sm font-mono";

/* ---- Types ---- */

export type McpTransportType = "stdio" | "sse" | "http";

export interface McpServerEntryStdio {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpServerEntryNetwork {
  type: "sse" | "http";
  url: string;
  env?: Record<string, string>;
}

export type McpServerEntry = McpServerEntryStdio | McpServerEntryNetwork;

export type McpServersMap = Record<string, McpServerEntry>;

/* ---- Internal row helpers ---- */

interface ServerRow {
  uid: string;
  name: string;
  transport: McpTransportType;
  command: string;
  args: string;
  url: string;
  envRows: { key: string; value: string }[];
  open: boolean;
}

let nextUid = 1;
function uid() {
  return `mcp-${nextUid++}`;
}

export function detectTransport(entry: Record<string, unknown>): McpTransportType {
  if (entry.type === "sse") return "sse";
  if (entry.type === "http" || entry.type === "url") return "http";
  return "stdio";
}

export function toRows(servers: McpServersMap | undefined): ServerRow[] {
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers).map(([name, entry]) => {
    const raw = entry as unknown as Record<string, unknown>;
    const transport = detectTransport(raw);
    const envObj = (raw.env ?? {}) as Record<string, string>;
    const envEntries = Object.entries(envObj).map(([key, value]) => ({ key, value }));
    return {
      uid: uid(),
      name,
      transport,
      command: typeof raw.command === "string" ? raw.command : "",
      args: Array.isArray(raw.args) ? (raw.args as string[]).join("\n") : "",
      url: typeof raw.url === "string" ? raw.url : "",
      envRows: [...envEntries, { key: "", value: "" }],
      open: true,
    };
  });
}

export function fromRows(rows: ServerRow[]): McpServersMap | undefined {
  const map: McpServersMap = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const env: Record<string, string> = {};
    for (const e of row.envRows) {
      const k = e.key.trim();
      if (k) env[k] = e.value;
    }
    const hasEnv = Object.keys(env).length > 0;

    if (row.transport === "sse" || row.transport === "http") {
      if (!row.url.trim()) continue;
      map[name] = {
        type: row.transport,
        url: row.url,
        ...(hasEnv ? { env } : {}),
      };
    } else {
      if (!row.command.trim()) continue;
      const args = row.args
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean);
      map[name] = {
        command: row.command,
        args,
        ...(hasEnv ? { env } : {}),
      };
    }
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

const TRANSPORT_OPTIONS: { value: McpTransportType; label: string; hint: string }[] = [
  { value: "stdio", label: "stdio", hint: "Spawn a local process (command + args)" },
  { value: "sse", label: "SSE", hint: "Connect to a running server via Server-Sent Events" },
  { value: "http", label: "HTTP (streamable)", hint: "Connect to a running server via streamable HTTP" },
];

/* ---- Component ---- */

export function McpServersEditor({
  value,
  onChange,
}: {
  value: McpServersMap | undefined;
  onChange: (servers: McpServersMap | undefined) => void;
}) {
  const [rows, setRows] = useState<ServerRow[]>(() => toRows(value));
  const valueRef = useRef(value);
  const emittingRef = useRef(false);

  useEffect(() => {
    if (emittingRef.current) {
      emittingRef.current = false;
      valueRef.current = value;
      return;
    }
    if (value !== valueRef.current) {
      valueRef.current = value;
      setRows(toRows(value));
    }
  }, [value]);

  function emit(nextRows: ServerRow[]) {
    emittingRef.current = true;
    onChange(fromRows(nextRows));
  }

  function updateRow(index: number, patch: Partial<ServerRow>) {
    const next = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
    setRows(next);
    emit(next);
  }

  function removeRow(index: number) {
    const next = rows.filter((_, i) => i !== index);
    setRows(next);
    emit(next);
  }

  function addServer() {
    const next = [
      ...rows,
      {
        uid: uid(),
        name: "",
        transport: "stdio" as McpTransportType,
        command: "",
        args: "",
        url: "",
        envRows: [{ key: "", value: "" }],
        open: true,
      },
    ];
    setRows(next);
    emit(next);
  }

  function updateEnvRow(
    serverIndex: number,
    envIndex: number,
    patch: { key?: string; value?: string },
  ) {
    const server = rows[serverIndex];
    const envRows = server.envRows.map((e, i) =>
      i === envIndex ? { ...e, ...patch } : e,
    );
    const last = envRows[envRows.length - 1];
    if (last && (last.key || last.value)) {
      envRows.push({ key: "", value: "" });
    }
    const next = rows.map((r, i) =>
      i === serverIndex ? { ...r, envRows } : r,
    );
    setRows(next);
    emit(next);
  }

  function removeEnvRow(serverIndex: number, envIndex: number) {
    const server = rows[serverIndex];
    let envRows = server.envRows.filter((_, i) => i !== envIndex);
    const last = envRows[envRows.length - 1];
    if (!last || last.key || last.value) {
      envRows.push({ key: "", value: "" });
    }
    const next = rows.map((r, i) =>
      i === serverIndex ? { ...r, envRows } : r,
    );
    setRows(next);
    emit(next);
  }

  function headerSubtitle(row: ServerRow): string {
    if (row.transport === "stdio") return row.command || "";
    return row.url || "";
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <Server className="mx-auto h-8 w-8 text-muted-foreground/30 mb-2" />
          <p className="text-sm text-muted-foreground/60">
            No MCP servers configured
          </p>
          <p className="text-xs text-muted-foreground/40 mt-1">
            Add MCP servers to give this agent access to external tools and data
            sources.
          </p>
        </div>
      )}

      {rows.map((row, index) => (
        <div
          key={row.uid}
          className="rounded-lg border border-border overflow-hidden"
        >
          {/* Header */}
          <button
            type="button"
            className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/30 transition-colors"
            onClick={() => updateRow(index, { open: !row.open })}
          >
            {row.open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <Server className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">
              {row.name || (
                <span className="text-muted-foreground/40 italic">
                  unnamed server
                </span>
              )}
            </span>
            <span className="ml-auto text-xs text-muted-foreground/50 font-mono truncate max-w-[200px]">
              {headerSubtitle(row)}
            </span>
            <button
              type="button"
              className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                removeRow(index);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </button>

          {/* Body */}
          {row.open && (
            <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
              {/* Server name */}
              <div>
                <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                  Server name
                  <HintIcon text="Unique identifier for this MCP server. Used in Claude Code's MCP config." />
                </label>
                <input
                  className={inputClass}
                  placeholder="e.g. my-mcp-server"
                  value={row.name}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                />
              </div>

              {/* Transport type */}
              <div>
                <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                  Transport
                  <HintIcon text="How Claude Code connects to this MCP server. stdio spawns a local process; SSE and HTTP connect to a running server." />
                </label>
                <select
                  className={selectClass}
                  value={row.transport}
                  onChange={(e) =>
                    updateRow(index, {
                      transport: e.target.value as McpTransportType,
                    })
                  }
                >
                  {TRANSPORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* stdio fields */}
              {row.transport === "stdio" && (
                <>
                  <div>
                    <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                      Command
                      <HintIcon text="The executable to run the MCP server (e.g. npx, node, python, uvx)." />
                    </label>
                    <input
                      className={inputClass}
                      placeholder="e.g. node"
                      value={row.command}
                      onChange={(e) =>
                        updateRow(index, { command: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                      Arguments
                      <HintIcon text="One argument per line. Passed to the command in order." />
                    </label>
                    <textarea
                      className={cn(inputClass, "resize-y min-h-[2.25rem]")}
                      rows={Math.max(2, row.args.split("\n").length)}
                      placeholder={"e.g.\n/path/to/server.js\n--stdio"}
                      value={row.args}
                      onChange={(e) =>
                        updateRow(index, { args: e.target.value })
                      }
                    />
                  </div>
                </>
              )}

              {/* SSE / URL fields */}
              {(row.transport === "sse" || row.transport === "http") && (
                <div>
                  <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                    URL
                    <HintIcon
                      text={
                        row.transport === "sse"
                          ? "The SSE endpoint URL of the running MCP server (e.g. http://localhost:3099/sse)."
                          : "The HTTP endpoint URL of the running MCP server (e.g. http://localhost:3099/mcp)."
                      }
                    />
                  </label>
                  <input
                    className={inputClass}
                    placeholder={
                      row.transport === "sse"
                        ? "e.g. http://localhost:3099/sse"
                        : "e.g. http://localhost:3099/mcp"
                    }
                    value={row.url}
                    onChange={(e) => updateRow(index, { url: e.target.value })}
                  />
                </div>
              )}

              {/* Env vars (all transport types) */}
              <div>
                <label className="text-xs text-muted-foreground flex items-center gap-1.5 mb-1">
                  Environment variables
                  <HintIcon text="Environment variables passed to this MCP server process." />
                </label>
                <div className="space-y-1.5">
                  {row.envRows.map((envRow, envIndex) => {
                    const isTrailing =
                      envIndex === row.envRows.length - 1 &&
                      !envRow.key &&
                      !envRow.value;
                    return (
                      <div key={envIndex} className="flex items-center gap-1.5">
                        <input
                          className={cn(inputClass, "flex-[2]")}
                          placeholder="KEY"
                          value={envRow.key}
                          onChange={(e) =>
                            updateEnvRow(index, envIndex, {
                              key: e.target.value,
                            })
                          }
                        />
                        <input
                          className={cn(inputClass, "flex-[3]")}
                          placeholder="value"
                          value={envRow.value}
                          onChange={(e) =>
                            updateEnvRow(index, envIndex, {
                              value: e.target.value,
                            })
                          }
                        />
                        {!isTrailing ? (
                          <button
                            type="button"
                            className="shrink-0 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            onClick={() => removeEnvRow(index, envIndex)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        ) : (
                          <div className="w-[26px] shrink-0" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={addServer}
      >
        <Plus className="h-3.5 w-3.5 mr-1.5" />
        Add MCP Server
      </Button>
    </div>
  );
}
