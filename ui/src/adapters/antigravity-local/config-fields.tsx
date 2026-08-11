import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Paperclip stages it into the Antigravity workspace as AGENTS.md when possible.";

export function AntigravityLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  if (hideInstructionsFile) return null;
  return (
    <>
      <Field
        label="Maximum tokens per run"
        hint="Required hard ceiling. Defaults to 100K; Paperclip stops the Antigravity process before another model step once streamed usage crosses it."
      >
        <DraftInput
          value={String(
            isCreate
              ? Number(values!.adapterSchemaValues?.maxTokensPerRun ?? 100_000)
              : eff(
                  "adapterConfig",
                  "maxTokensPerRun",
                  Number(config.maxTokensPerRun ?? 100_000),
                ),
          )}
          onCommit={(v) => {
            const parsed = Math.max(1, Math.floor(Number(v) || 100_000));
            if (isCreate) {
              set!({
                adapterSchemaValues: {
                  ...(values!.adapterSchemaValues ?? {}),
                  maxTokensPerRun: parsed,
                },
              });
            }
            else mark("adapterConfig", "maxTokensPerRun", parsed);
          }}
          immediate
          className={inputClass}
          inputMode="numeric"
        />
      </Field>
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
    </>
  );
}
