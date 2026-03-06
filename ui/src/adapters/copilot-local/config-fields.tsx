import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function CopilotLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="Working directory" hint="Absolute path to the project root. Copilot runs here. Must be pre-trusted via interactive session or ~/.copilot/config.json trusted_folders.">
        <DraftInput
          value={
            isCreate
              ? values!.cwd
              : eff("adapterConfig", "cwd", String(config.cwd ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ cwd: v })
              : mark("adapterConfig", "cwd", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="/absolute/path/to/project"
        />
      </Field>

      <Field
        label="Environment variables"
        hint="One per line (KEY=VALUE). Set COPILOT_GITHUB_TOKEN with a fine-grained PAT that has the 'Copilot Requests' permission."
      >
        <DraftInput
          value={
            isCreate
              ? values!.envVars
              : eff("adapterConfig", "envVars", String(config.envVars ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ envVars: v })
              : mark("adapterConfig", "envVars", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="COPILOT_GITHUB_TOKEN=github_pat_..."
        />
      </Field>
    </>
  );
}
