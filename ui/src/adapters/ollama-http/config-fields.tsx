import { useEffect, useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatJsonObject(value: unknown): string {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? JSON.stringify(record, null, 2) : "";
}

export function OllamaHttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const existingHeaders = formatJsonObject(eff("adapterConfig", "headers", config.headers ?? {}));
  const [headersDraft, setHeadersDraft] = useState(existingHeaders);

  useEffect(() => {
    if (!isCreate) setHeadersDraft(existingHeaders);
  }, [existingHeaders, isCreate]);

  const commitHeaders = (next: string) => {
    setHeadersDraft(next);
    if (isCreate) return;

    const trimmed = next.trim();
    if (!trimmed) {
      mark("adapterConfig", "headers", undefined);
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        mark("adapterConfig", "headers", parsed);
      }
    } catch {
      // Keep local draft until valid JSON is provided.
    }
  };

  return (
    <>
      <Field label="Base URL" hint="Absolute Ollama-compatible HTTP endpoint, for example https://ollama-api.example.com.">
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "baseUrl", String(config.baseUrl ?? config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "baseUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://ollama-api.example.com"
        />
      </Field>

      {!hideInstructionsFile && (
        <Field
          label="Instructions file"
          hint="Optional path to a local markdown file prepended to the generated Ollama prompt."
        >
          <DraftInput
            value={
              isCreate
                ? values!.instructionsFilePath ?? ""
                : eff("adapterConfig", "instructionsFilePath", String(config.instructionsFilePath ?? ""))
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
        </Field>
      )}

      <div className="rounded-md border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs text-blue-100">
        Leave the model blank to auto-select from <code>/api/tags</code>. Enter a model ID manually if you want to pin a specific Ollama model.
      </div>

      {!isCreate && (
        <>
          <Field label="Tags URL (optional)" hint="Override the model discovery endpoint. Defaults to &lt;baseUrl&gt;/api/tags.">
            <DraftInput
              value={eff("adapterConfig", "tagsUrl", String(config.tagsUrl ?? ""))}
              onCommit={(v) => mark("adapterConfig", "tagsUrl", v || undefined)}
              immediate
              className={inputClass}
              placeholder="https://ollama-api.example.com/api/tags"
            />
          </Field>

          <Field label="Chat URL (optional)" hint="Override the chat endpoint. Defaults to &lt;baseUrl&gt;/api/chat.">
            <DraftInput
              value={eff("adapterConfig", "chatUrl", String(config.chatUrl ?? ""))}
              onCommit={(v) => mark("adapterConfig", "chatUrl", v || undefined)}
              immediate
              className={inputClass}
              placeholder="https://ollama-api.example.com/api/chat"
            />
          </Field>

          <Field label="Headers JSON (optional)" hint="Extra HTTP headers sent to the Ollama endpoint.">
            <textarea
              className={`${inputClass} min-h-[120px]`}
              value={headersDraft}
              onChange={(event) => commitHeaders(event.target.value)}
              placeholder={`{\n  "Authorization": "Bearer ..."\n}`}
            />
          </Field>

          <Field label="Temperature (optional)" hint="Numeric Ollama temperature override.">
            <DraftInput
              value={eff("adapterConfig", "temperature", String(config.temperature ?? ""))}
              onCommit={(v) => {
                const parsed = Number.parseFloat(v.trim());
                mark("adapterConfig", "temperature", Number.isFinite(parsed) ? parsed : undefined);
              }}
              immediate
              className={inputClass}
              placeholder="0.2"
            />
          </Field>

          <Field label="keep_alive (optional)" hint="Optional Ollama keep_alive value, for example 5m.">
            <DraftInput
              value={eff("adapterConfig", "keepAlive", String(config.keepAlive ?? ""))}
              onCommit={(v) => mark("adapterConfig", "keepAlive", v || undefined)}
              immediate
              className={inputClass}
              placeholder="5m"
            />
          </Field>
        </>
      )}
    </>
  );
}