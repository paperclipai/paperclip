import { useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const HERMES_MODEL_OPTIONS = [
  { value: "", label: "Auto-detect from Hermes Agent" },
  { value: "openrouter/hunter-alpha", label: "OpenRouter - Hunter Alpha" },
  { value: "openrouter/claude-sonnet-4", label: "OpenRouter - Claude Sonnet 4" },
  { value: "openrouter/claude-opus-4", label: "OpenRouter - Claude Opus 4" },
  { value: "openrouter/gpt-4.1", label: "OpenRouter - GPT-4.1" },
  { value: "openrouter/gemini-2.5-pro", label: "OpenRouter - Gemini 2.5 Pro" },
  { value: "anthropic/claude-sonnet-4", label: "Anthropic - Claude Sonnet 4" },
  { value: "anthropic/claude-opus-4", label: "Anthropic - Claude Opus 4" },
  { value: "openai/gpt-4.1", label: "OpenAI - GPT-4.1" },
  { value: "openai/o3", label: "OpenAI - o3" },
  { value: "custom", label: "Custom model (enter below)" },
];

const PROVIDER_OPTIONS = [
  { value: "", label: "Auto-detect from Hermes Agent" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "nous", label: "Nous Research" },
  { value: "openai-codex", label: "OpenAI Codex" },
  { value: "anthropic", label: "Anthropic" },
  { value: "zai", label: "Z.AI (GLM)" },
  { value: "kimi-coding", label: "Kimi Coding" },
];

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
  const [modelOpen, setModelOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);

  const currentModel = isCreate
    ? (values?.model ?? "")
    : eff("adapterConfig", "model", String(config.model ?? ""));

  const currentProvider = isCreate
    ? (values?.args ?? "")
    : eff("adapterConfig", "provider", String(config.provider ?? ""));

  const isCustomModel =
    currentModel && !HERMES_MODEL_OPTIONS.some((o) => o.value === currentModel);

  const selectedModelLabel = isCustomModel
    ? currentModel
    : HERMES_MODEL_OPTIONS.find((o) => o.value === currentModel)?.label ??
      "Auto-detect from Hermes Agent";

  const selectedProviderLabel =
    PROVIDER_OPTIONS.find((o) => o.value === currentProvider)?.label ??
    "Auto-detect from Hermes Agent";

  return (
    <>
      <Field
        label="Model"
        hint="Auto-detect uses your current Hermes default (run 'hermes status' to see). Select a preset or choose 'Custom' to enter any model string."
      >
        <div className="space-y-2">
          <Popover open={modelOpen} onOpenChange={setModelOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
                <span
                  className={cn(currentModel === "" && "text-muted-foreground")}
                >
                  {selectedModelLabel}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--radix-popover-trigger-width)] p-1 max-h-[300px] overflow-y-auto"
              align="start"
            >
              {HERMES_MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  className={cn(
                    "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 text-left",
                    opt.value === currentModel &&
                      !isCustomModel &&
                      "bg-accent",
                    opt.value === "" && currentModel === "" &&
                      "text-muted-foreground",
                  )}
                  onClick={() => {
                    if (isCreate) {
                      set!({ model: opt.value });
                    } else {
                      mark(
                        "adapterConfig",
                        "model",
                        opt.value || undefined,
                      );
                    }
                    setModelOpen(false);
                  }}
                >
                  <span className="truncate" title={opt.label}>
                    {opt.label}
                  </span>
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {(currentModel === "custom" || isCustomModel) && (
            <DraftInput
              value={currentModel === "custom" ? "" : currentModel}
              onCommit={(v) => {
                if (!v) return; // keep "custom" selected; buildHermesConfig strips it on save
                if (isCreate) {
                  set!({ model: v });
                } else {
                  mark("adapterConfig", "model", v || undefined);
                }
              }}
              immediate
              className={inputClass}
              placeholder="Enter custom model (e.g. openrouter/anthropic/claude-3.5-sonnet)"
            />
          )}
        </div>
      </Field>

      <Field
        label="Provider"
        hint="Leave empty to auto-detect from model name, or specify explicitly."
      >
        <Popover open={providerOpen} onOpenChange={setProviderOpen}>
          <PopoverTrigger asChild>
            <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-accent/50 transition-colors w-full justify-between">
              <span
                className={cn(!currentProvider && "text-muted-foreground")}
              >
                {selectedProviderLabel}
              </span>
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[var(--radix-popover-trigger-width)] p-1"
            align="start"
          >
            {PROVIDER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={cn(
                  "flex items-center w-full px-2 py-1.5 text-sm rounded hover:bg-accent/50 text-left",
                  opt.value === currentProvider && "bg-accent",
                  opt.value === "" && currentProvider === "" &&
                    "text-muted-foreground",
                )}
                onClick={() => {
                  if (isCreate) {
                    set!({ args: opt.value });
                  } else {
                    mark(
                      "adapterConfig",
                      "provider",
                      opt.value || undefined,
                    );
                  }
                  setProviderOpen(false);
                }}
              >
                {opt.label}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </Field>

      <Field
        label="Hermes CLI command"
        hint="Path to the hermes binary (default: hermes)"
      >
        <DraftInput
          value={
            isCreate
              ? values?.command ?? "hermes"
              : eff(
                  "adapterConfig",
                  "hermesCommand",
                  String(config.hermesCommand ?? "hermes"),
                )
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
