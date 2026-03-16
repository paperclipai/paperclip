import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HermesLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Hermes CLI command" hint="Path to the hermes binary (default: hermes)">
        <DraftInput
          value={
            isCreate
              ? values?.command ?? "hermes"
              : eff("adapterConfig", "hermesCommand", String(config.command ?? "hermes"))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ command: v })
              : mark("adapterConfig", "hermesCommand", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="hermes"
        />
      </Field>

      <Field label="Provider" hint="API provider (auto-detected from model name if not set)">
        <DraftInput
          value={
            isCreate
              ? values?.args ?? ""
              : eff("adapterConfig", "provider", String(config.args ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ args: v })
              : mark("adapterConfig", "provider", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="auto"
        />
      </Field>

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