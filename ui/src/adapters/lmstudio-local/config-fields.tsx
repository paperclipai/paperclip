import React from "react";
import type { AdapterConfigFieldsProps } from "../types";
import { Field, DraftInput } from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function LmStudioLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <Field label="LM Studio base URL">
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:1234"
        />
      </Field>
      <Field label="Model">
        <DraftInput
          value={
            isCreate
              ? values!.model
              : eff("adapterConfig", "model", String(config.model ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ model: v })
              : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="qwen/qwen3.5-35b-a3b"
        />
      </Field>
      <Field label="System prompt (optional)">
        <textarea
          value={eff("adapterConfig", "systemPrompt", String(config.systemPrompt ?? ""))}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => mark("adapterConfig", "systemPrompt", e.target.value || undefined)}
          className={inputClass + " min-h-[80px] resize-y"}
          placeholder="You are a practical local AI worker inside Paperclip. Be concise, accurate, and action-oriented."
        />
      </Field>
    </>
  );
}
