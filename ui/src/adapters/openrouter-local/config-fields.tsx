import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";

export function OpenRouterLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  return (
    <>
      {/* Instructions file */}
      {!hideInstructionsFile && (
        <Field label="Agent instructions file" hint={instructionsFileHint}>
          <div className="flex items-center gap-2">
            <DraftInput
              value={
                isCreate
                  ? values?.instructionsFilePath ?? ""
                  : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
              }
              onCommit={(v) =>
                isCreate
                  ? set?.({ instructionsFilePath: v })
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

      {/* Timeout — edit mode only */}
      {!isCreate && (
        <Field label="Timeout (seconds)" hint="Max execution time per run (default: 600)">
          <DraftInput
            value={eff("adapterConfig", "timeoutSec", String(config.timeoutSec ?? "600"))}
            onCommit={(v) => mark("adapterConfig", "timeoutSec", v ? Number(v) : undefined)}
            immediate
            className={inputClass}
            placeholder="600"
          />
        </Field>
      )}

      {/* Max turns — edit mode only */}
      {!isCreate && (
        <Field label="Max turns" hint="Max conversation turns per run (default: 30)">
          <DraftInput
            value={eff("adapterConfig", "maxTurns", String(config.maxTurns ?? "30"))}
            onCommit={(v) => mark("adapterConfig", "maxTurns", v ? Number(v) : undefined)}
            immediate
            className={inputClass}
            placeholder="30"
          />
        </Field>
      )}
    </>
  );
}
