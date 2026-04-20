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

export function CopilotLocalConfigFields({
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
      {!isCreate && (
        <>
          <Field
            label="GHE hostname"
            hint="GitHub Enterprise hostname (e.g. github.mycompany.com). Leave empty for github.com."
          >
            <DraftInput
              value={eff(
                "adapterConfig",
                "gheHost",
                String(config.gheHost ?? ""),
              )}
              onCommit={(v) =>
                mark("adapterConfig", "gheHost", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="github.com (default)"
            />
          </Field>
          <Field
            label="Effort"
            hint="Reasoning effort: low, medium, or high."
          >
            <DraftInput
              value={eff(
                "adapterConfig",
                "effort",
                String(config.effort ?? ""),
              )}
              onCommit={(v) =>
                mark("adapterConfig", "effort", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="medium (default)"
            />
          </Field>
          <Field
            label="BYOK Base URL"
            hint="Custom OpenAI-compatible endpoint URL for BYOK mode."
          >
            <DraftInput
              value={eff(
                "adapterConfig",
                "byokBaseUrl",
                String(config.byokBaseUrl ?? ""),
              )}
              onCommit={(v) =>
                mark("adapterConfig", "byokBaseUrl", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="https://custom-endpoint/v1"
            />
          </Field>
          <Field
            label="BYOK API Key"
            hint="API key for custom BYOK endpoint."
          >
            <DraftInput
              value={eff(
                "adapterConfig",
                "byokApiKey",
                String(config.byokApiKey ?? ""),
              )}
              onCommit={(v) =>
                mark("adapterConfig", "byokApiKey", v || undefined)
              }
              immediate
              className={inputClass}
              placeholder="sk-..."
              type="password"
            />
          </Field>
        </>
      )}
    </>
  );
}
