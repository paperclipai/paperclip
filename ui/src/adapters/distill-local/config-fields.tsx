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
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Paperclip stages it into the Distill workspace as Agents.md when possible.";

const EXECUTION_MODES = ["auto", "normal", "ultrafast", "ultracode", "ultrasave"];
const EFFORTS = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
const OPENROUTER_VARIANTS = ["floor", "nitro", "exacto", "none"];

type Option = { value: string; label: string };

export function DistillLocalConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  // Distill-only settings live in adapterSchemaValues while creating and in adapterConfig when editing.
  const read = (key: string) =>
    isCreate
      ? String(values!.adapterSchemaValues?.[key] ?? "")
      : eff("adapterConfig", key, String(config[key] ?? ""));
  const write = (key: string, value: string) =>
    isCreate
      ? set!({ adapterSchemaValues: { ...values!.adapterSchemaValues, [key]: value || undefined } })
      : mark("adapterConfig", key, value || undefined);

  const select = (key: string, label: string, hint: string, options: Option[]) => (
    <Field label={label} hint={hint}>
      <select className={inputClass} value={read(key)} onChange={(e) => write(key, e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
  const withDefault = (items: string[]): Option[] => [
    { value: "", label: "Distill default" },
    ...items.map((value) => ({ value, label: value })),
  ];
  const workerModelOptions: Option[] = [
    { value: "", label: "Distill default (host config)" },
    { value: "none", label: "No worker (main model does all the work)" },
    ...models.filter((m) => m.id !== "auto").map((m) => ({ value: m.id, label: m.label })),
  ];

  return configFieldsForSection(section, (
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
      {select("mode", "Execution mode", "Passed as --mode. Only modes that allow delegation (for example normal) use the worker model.", withDefault(EXECUTION_MODES))}
      {select("workerModel", "Worker model", "Runs the subagents the main model delegates. Ignored when Model is \"auto\", which routes the worker too.", workerModelOptions)}
      {select("workerEffort", "Worker effort", "Reasoning effort for the worker model.", withDefault(EFFORTS))}
      {select("mainVariant", "OpenRouter variant (main)", "Routing suffix appended to the main model on OpenRouter.", withDefault(OPENROUTER_VARIANTS))}
      {select("workerVariant", "OpenRouter variant (worker)", "Routing suffix appended to the worker model on OpenRouter.", withDefault(OPENROUTER_VARIANTS))}
    </>
  ));
}
