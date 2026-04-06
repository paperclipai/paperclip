import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const DEFAULT_BASE_URL = "http://localhost:1234/v1";

function SecretField({
  label,
  hint,
  value,
  onCommit,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

export function LmStudioLocalConfigFields({
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
      <Field
        label="API Base URL"
        hint="LM Studio's OpenAI-compatible endpoint. Default: http://localhost:1234/v1"
      >
        <DraftInput
          value={
            isCreate
              ? values!.url || DEFAULT_BASE_URL
              : eff("adapterConfig", "apiBaseUrl", String(config.apiBaseUrl ?? DEFAULT_BASE_URL))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v || DEFAULT_BASE_URL })
              : mark("adapterConfig", "apiBaseUrl", v || DEFAULT_BASE_URL)
          }
          immediate
          className={inputClass}
          placeholder={DEFAULT_BASE_URL}
        />
      </Field>

      <SecretField
        label="API Key"
        hint="LM Studio doesn't require a real key. Use 'lm-studio' as a placeholder."
        value={
          isCreate
            ? values!.envBindings?.LMSTUDIO_API_KEY as string ?? "lm-studio"
            : eff("adapterConfig", "apiKey", String(config.apiKey ?? "lm-studio"))
        }
        onCommit={(v) => {
          const key = v.trim() || "lm-studio";
          if (isCreate) {
            set!({ envBindings: { ...values!.envBindings, LMSTUDIO_API_KEY: key } });
          } else {
            mark("adapterConfig", "apiKey", key);
          }
        }}
        placeholder="lm-studio"
      />

      {!hideInstructionsFile && (
        <Field
          label="Agent instructions file"
          hint="Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior."
        >
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
