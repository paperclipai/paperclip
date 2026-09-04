import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the Antigravity prompt at runtime.";

export function AgyLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const rawValues = values as unknown as (Record<string, unknown> | undefined);
  const rawMode = isCreate
    ? (rawValues?.mode as string | undefined) ?? ""
    : eff("adapterConfig", "mode", String(config.mode ?? ""));
  const mode = rawMode === "plan" ? "plan" : "accept-edits";

  return (
    <>
      {!hideInstructionsFile && (
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
      )}
      <Field
        label="Execution mode"
        hint="Plan mode restricts the agent to non-mutating research and planning. Edit mode enables full autonomous edits."
      >
        <select
          className={inputClass}
          value={mode}
          onChange={(e) => {
            const val = e.target.value;
            isCreate
              ? set!({ mode: val === "plan" ? "plan" : undefined } as any)
              : mark("adapterConfig", "mode", val === "plan" ? "plan" : undefined);
          }}
        >
          <option value="accept-edits">Edit Mode (accept-edits) — Full autonomous execution</option>
          <option value="plan">Plan Mode (plan) — Non-mutating planning & research</option>
        </select>
      </Field>
      <Field
        label="Agent persona"
        hint="Optional Antigravity subagent persona name (e.g. research, flutter_a11y_agent). Corresponds to agy --agent <name>."
      >
        <DraftInput
          value={
            isCreate
              ? (values as any)?.agent ?? ""
              : eff(
                  "adapterConfig",
                  "agent",
                  String(config.agent ?? config.agentPersona ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ agent: v || undefined } as any)
              : mark("adapterConfig", "agent", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="e.g. research, flutter_a11y_agent"
        />
      </Field>
      <Field
        label="Structured output schema"
        hint="Optional JSON schema or path to a schema file to enforce structured output for the final result."
      >
        <DraftInput
          value={
            isCreate
              ? (values as any)?.jsonSchema ?? ""
              : eff(
                  "adapterConfig",
                  "jsonSchema",
                  String(config.jsonSchema ?? config.json_schema ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ jsonSchema: v || undefined } as any)
              : mark("adapterConfig", "jsonSchema", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/path/to/schema.json or inline JSON schema"
        />
      </Field>
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? Boolean(values?.dangerouslySkipPermissions)
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                Boolean(config.dangerouslySkipPermissions),
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v ? true : undefined)
        }
      />
      <Field
        label="Project name"
        hint="Optional Antigravity project name or ID for conversation and memory grouping (--project)."
      >
        <DraftInput
          value={
            isCreate
              ? (values as any)?.project ?? ""
              : eff("adapterConfig", "project", String(config.project ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ project: v || undefined } as any)
              : mark("adapterConfig", "project", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="e.g. paperclip, my-project"
        />
      </Field>
      <Field
        label="Print timeout"
        hint="Optional CLI print mode wait timeout (e.g. 15m, 30m, 1h). Defaults to aligned Paperclip timeout or 24h."
      >
        <DraftInput
          value={
            isCreate
              ? (values as any)?.printTimeout ?? ""
              : eff("adapterConfig", "printTimeout", String(config.printTimeout ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ printTimeout: v || undefined } as any)
              : mark("adapterConfig", "printTimeout", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="e.g. 15m, 30m, 1h"
        />
      </Field>
      <ToggleField
        label="Disable slash commands"
        hint="Disable slash command and skill expansion in print mode (--disable-slash-commands)."
        checked={
          isCreate
            ? Boolean((values as any)?.disableSlashCommands)
            : eff(
                "adapterConfig",
                "disableSlashCommands",
                Boolean(config.disableSlashCommands),
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ disableSlashCommands: v } as any)
            : mark("adapterConfig", "disableSlashCommands", v ? true : undefined)
        }
      />
      <ToggleField
        label="Sandbox mode"
        hint="Enable strict Antigravity terminal restrictions and sandboxing."
        checked={
          isCreate
            ? Boolean((values as any)?.sandbox)
            : eff(
                "adapterConfig",
                "sandbox",
                Boolean(config.sandbox),
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ sandbox: v } as any)
            : mark("adapterConfig", "sandbox", v ? true : undefined)
        }
      />
    </>
  );
}
