import { configFieldsForSection } from "../config-sections";
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the T3 Code message at runtime.";
const providerHint =
  "T3 Code provider instance id, such as claudeAgent or codex. Set it together with a model, or leave both empty for the project's default model.";

export function T3CodeLocalConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return configFieldsForSection(section, (
    <>
      <Field configSection="adapter" label="T3 Code provider" hint={providerHint}>
        <DraftInput
          value={
            isCreate
              ? String(values!.adapterSchemaValues?.provider ?? "")
              : eff("adapterConfig", "provider", String(config.provider ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ adapterSchemaValues: { ...values!.adapterSchemaValues, provider: v } })
              : mark("adapterConfig", "provider", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="project default"
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
  ));
}
