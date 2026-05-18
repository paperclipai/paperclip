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
const endpointHint =
  "Optional. When set, the adapter talks to a remote Hermes gateway (POST /v1/runs + SSE /v1/runs/{id}/events) instead of spawning hermes locally. Use for agents whose Hermes runtime lives on another machine (e.g. over Tailscale).";

export function HermesLocalConfigFields({
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
      <Field label="Remote gateway endpoint" hint={endpointHint}>
        <DraftInput
          value={
            isCreate
              ? values!.endpoint ?? ""
              : eff(
                  "adapterConfig",
                  "endpoint",
                  String(config.endpoint ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ endpoint: v })
              : mark("adapterConfig", "endpoint", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://host.example:8642"
        />
      </Field>
    </>
  );
}
