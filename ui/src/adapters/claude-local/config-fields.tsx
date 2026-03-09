import { useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { cn } from "../../lib/utils";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

/* ---- Tool access control ---- */

const CLAUDE_CORE_TOOLS = [
  { id: "Read", label: "Read" },
  { id: "Write", label: "Write" },
  { id: "Edit", label: "Edit" },
  { id: "MultiEdit", label: "MultiEdit" },
  { id: "Bash", label: "Bash" },
  { id: "Glob", label: "Glob" },
  { id: "Grep", label: "Grep" },
  { id: "WebFetch", label: "WebFetch" },
  { id: "WebSearch", label: "WebSearch" },
  { id: "TodoRead", label: "TodoRead" },
  { id: "TodoWrite", label: "TodoWrite" },
];

const BASH_PATTERNS = [
  { id: "Bash(git:*)", label: "git" },
  { id: "Bash(npm:*)", label: "npm" },
  { id: "Bash(curl:*)", label: "curl" },
  { id: "Bash(python:*)", label: "python" },
  { id: "Bash(read-only)", label: "read-only" },
];

type ToolAccessMode = "default" | "allow" | "block";

function parseToolList(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.filter((v) => typeof v === "string").join(",");
  return "";
}

function toolSet(csv: string): Set<string> {
  return new Set(
    csv
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

function toggleInCsv(csv: string, tool: string): string {
  const set = toolSet(csv);
  if (set.has(tool)) set.delete(tool);
  else set.add(tool);
  return Array.from(set).join(",");
}

export function ClaudeLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <Field label="Agent instructions file" hint={instructionsFileHint}>
      <div className="flex items-center gap-2">
        <DraftInput
          value={
            isCreate
              ? values!.instructionsFilePath ?? ""
              : eff(
                  "adapterConfig",
                  "instructionsFilePath",
                  String(config.instructionsFilePath ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ instructionsFilePath: v })
              : mark("adapterConfig", "instructionsFilePath", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/absolute/path/to/AGENTS.md"
        />
        <ChoosePathButton />
      </div>
    </Field>
  );
}

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const currentAllowed = isCreate
    ? values!.allowedTools
    : parseToolList(eff("adapterConfig", "allowedTools", parseToolList(config.allowedTools)));
  const currentDisallowed = isCreate
    ? values!.disallowedTools
    : parseToolList(eff("adapterConfig", "disallowedTools", parseToolList(config.disallowedTools)));

  const initialMode: ToolAccessMode = currentAllowed.trim()
    ? "allow"
    : currentDisallowed.trim()
      ? "block"
      : "default";

  const [mode, setMode] = useState<ToolAccessMode>(initialMode);

  const skipPerms = isCreate
    ? values!.dangerouslySkipPermissions
    : eff("adapterConfig", "dangerouslySkipPermissions", config.dangerouslySkipPermissions === true);

  const activeList = mode === "allow" ? currentAllowed : mode === "block" ? currentDisallowed : "";
  const active = toolSet(activeList);
  const hasBash = active.has("Bash");

  const setField = (field: "allowedTools" | "disallowedTools", val: string) => {
    if (isCreate) set!({ [field]: val });
    else mark("adapterConfig", field, val || undefined);
  };

  const switchMode = (next: ToolAccessMode) => {
    setMode(next);
    setField("allowedTools", "");
    setField("disallowedTools", "");
  };

  const toggle = (tool: string) => {
    const field = mode === "allow" ? "allowedTools" : "disallowedTools";
    setField(field, toggleInCsv(activeList, tool));
  };

  const modeBtn = (m: ToolAccessMode, label: string, hint: string) => (
    <button
      type="button"
      title={hint}
      className={cn(
        "px-2 py-1 text-xs rounded-md border transition-colors",
        mode === m
          ? "border-accent-foreground/30 bg-accent text-accent-foreground"
          : "border-border text-muted-foreground hover:bg-accent/50",
      )}
      onClick={() => { if (mode !== m) switchMode(m); }}
    >
      {label}
    </button>
  );

  return (
    <>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions === true,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      {/* ---- Tool access control ---- */}
      <div className={cn(skipPerms && "opacity-40 pointer-events-none", "space-y-2")}>
        <Field
          label="Tool access"
          hint={skipPerms ? "Disabled when 'Skip permissions' is on" : help.allowedTools}
        >
          <div className="flex gap-1 mb-2">
            {modeBtn("default", "Default (prompts)", "Agent uses Claude's default permission prompts per tool — will stall in unattended mode")}
            {modeBtn("allow", "Allowed only", "Pre-approve specific tools for unattended operation — everything else is blocked")}
            {modeBtn("block", "Block specific", "Block specific tools — everything else is auto-approved")}
          </div>

          {mode !== "default" && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {CLAUDE_CORE_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    className={cn(
                      "px-2 py-0.5 text-xs rounded border transition-colors select-none",
                      active.has(tool.id)
                        ? mode === "allow"
                          ? "border-green-600/40 bg-green-600/15 text-green-400"
                          : "border-red-600/40 bg-red-600/15 text-red-400"
                        : "border-border text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => toggle(tool.id)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>

              {mode === "allow" && !hasBash && (
                <div>
                  <span className="text-xs text-muted-foreground mb-1 block">
                    Bash patterns (instead of full Bash):
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {BASH_PATTERNS.map((bp) => (
                      <button
                        key={bp.id}
                        type="button"
                        className={cn(
                          "px-2 py-0.5 text-xs rounded border transition-colors select-none",
                          active.has(bp.id)
                            ? "border-green-600/40 bg-green-600/15 text-green-400"
                            : "border-border text-muted-foreground hover:bg-accent/50",
                        )}
                        onClick={() => toggle(bp.id)}
                      >
                        {bp.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <DraftInput
                value={
                  Array.from(active)
                    .filter(
                      (t) =>
                        !CLAUDE_CORE_TOOLS.some((c) => c.id === t) &&
                        !BASH_PATTERNS.some((b) => b.id === t),
                    )
                    .join(",")
                }
                onCommit={(v) => {
                  const knownSelected = Array.from(active).filter(
                    (t) =>
                      CLAUDE_CORE_TOOLS.some((c) => c.id === t) ||
                      BASH_PATTERNS.some((b) => b.id === t),
                  );
                  const custom = v
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean);
                  const combined = [...knownSelected, ...custom].join(",");
                  const field = mode === "allow" ? "allowedTools" : "disallowedTools";
                  setField(field, combined);
                }}
                immediate
                className={inputClass}
                placeholder="Custom patterns (e.g. mcp__github__*)"
              />
            </div>
          )}
        </Field>
      </div>
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 80),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 80)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}