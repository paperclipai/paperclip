/**
 * Agent-creation/edit form fields for amplifier-local. Renders only the
 * adapter-specific fields — model, cwd, env, command, timeout, etc. are
 * rendered by the shared parent form.
 *
 * Fields:
 *   - Agent instructions file (markdown file prepended to the system prompt)
 *   - Allow protocol skew (advanced — bypass the wrapper's pre-flight
 *     protocol-version check; UNSAFE outside dev)
 *   - LocalWorkspaceRuntimeFields (workspace strategy + runtime services)
 */

import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) prepended to the amplifier-agent prompt at runtime. The engine's tool-skills module also surfaces team skills automatically — use this for agent-specific instructions that don't belong in shared skills.";
const allowSkewHint =
  "Bypass the wrapper's protocol-version pre-flight check. UNSAFE — only use when intentionally pairing a wrapper and engine across a known-incompatible protocol gap during development.";

export function AmplifierLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  // CreateConfigValues is a closed type; cast through unknown to reach
  // adapter-specific fields (allowProtocolSkew, instructionsFilePath).
  const valuesAny = (values ?? {}) as unknown as Record<string, unknown>;
  const allowSkewEnabled = isCreate
    ? Boolean(valuesAny.allowProtocolSkew)
    : eff("adapterConfig", "allowProtocolSkew", Boolean(config.allowProtocolSkew));

  return (
    <>
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? (typeof valuesAny.instructionsFilePath === "string"
                      ? valuesAny.instructionsFilePath
                      : "")
                  : eff(
                      "adapterConfig",
                      "instructionsFilePath",
                      String(config.instructionsFilePath ?? ""),
                    )
              }
              onCommit={(v: string) =>
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
      <ToggleField
        label="Allow protocol skew (advanced)"
        hint={allowSkewHint}
        checked={allowSkewEnabled}
        onChange={(v: boolean) =>
          isCreate
            ? set!({ allowProtocolSkew: v } as Record<string, unknown>)
            : mark("adapterConfig", "allowProtocolSkew", v)
        }
      />
      <LocalWorkspaceRuntimeFields
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
        eff={eff}
        mode={mode}
        adapterType={adapterType}
        models={models}
      />
    </>
  );
}
