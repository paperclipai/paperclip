// Configuration fields for the Antigravity local adapter
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
  ToggleField,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the Antigravity prompt at runtime.";

// Renders the Antigravity-specific configuration fields in the agent edit and create forms
export function AntigravityLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Skip permissions"
        hint="Passes --dangerously-skip-permissions to agy to auto-approve tool execution. Recommended only for trusted, sandboxed environments."
        checked={
          isCreate
            ? Boolean(values!.dangerouslySkipPermissions)
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                Boolean(config.dangerouslySkipPermissions),
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <ToggleField
        label="Sandbox mode"
        hint="Passes --sandbox to agy to run in a sandbox with terminal restrictions enabled."
        checked={
          isCreate
            ? Boolean(values!.antigravitySandbox)
            : eff("adapterConfig", "sandbox", Boolean(config.sandbox))
        }
        onChange={(v) =>
          isCreate
            ? set!({ antigravitySandbox: v })
            : mark("adapterConfig", "sandbox", v)
        }
      />
      <Field
        label="Antigravity agent"
        hint="Optional subagent or personality name passed via --agent (e.g. 'code-reviewer')."
      >
        <DraftInput
          value={
            isCreate
              ? values!.antigravityAgent ?? ""
              : eff("adapterConfig", "agent", String(config.agent ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ antigravityAgent: v })
              : mark("adapterConfig", "agent", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="default"
        />
      </Field>
      <Field
        label="Print timeout"
        hint="Timeout duration passed via --print-timeout (e.g. '30m', '1h')."
      >
        <DraftInput
          value={
            isCreate
              ? values!.antigravityPrintTimeout ?? ""
              : eff("adapterConfig", "printTimeout", String(config.printTimeout ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ antigravityPrintTimeout: v })
              : mark("adapterConfig", "printTimeout", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="30m"
        />
      </Field>
      <Field
        label="Extra CLI arguments"
        hint="Additional CLI flags or arguments appended to the agy invocation."
      >
        <DraftInput
          value={
            isCreate
              ? values!.extraArgs ?? ""
              : eff(
                  "adapterConfig",
                  "extraArgs",
                  Array.isArray(config.extraArgs)
                    ? (config.extraArgs as string[]).join(", ")
                    : String(config.extraArgs ?? ""),
                )
          }
          onCommit={(v) => {
            if (isCreate) {
              set!({ extraArgs: v });
            } else {
              const trimmed = v?.trim();
              const parsed = trimmed
                ? (trimmed.includes(",") ? trimmed.split(",") : trimmed.split(/\s+/))
                    .map((s) => s.trim())
                    .filter(Boolean)
                : undefined;
              mark("adapterConfig", "extraArgs", parsed && parsed.length > 0 ? parsed : undefined);
            }
          }}
          immediate
          className={inputClass}
          placeholder="--verbose"
        />
      </Field>
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
    </>
  );
}
