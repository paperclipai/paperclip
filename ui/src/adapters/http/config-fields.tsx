import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  help,
} from "../../components/agent-config-primitives";
import { DEFAULT_RUNTIME_PROFILES } from "@paperclipai/shared";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function HttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  runtimeProfiles,
}: AdapterConfigFieldsProps) {
  const profileOptions = (runtimeProfiles ?? []).length > 0
    ? runtimeProfiles!
    : DEFAULT_RUNTIME_PROFILES;
  const createRuntimeProfile = isCreate
    ? (values!.httpRuntimeProfile ?? "custom-http")
    : String(eff("adapterConfig", "runtimeProfile", String(config.runtimeProfile ?? "custom-http")));
  const configuredHeaders =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? (config.headers as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "headers", configuredHeaders) as Record<string, unknown>) ?? {};
  const runtimeHint =
    isCreate
      ? (values!.httpRuntimeHeader ?? "")
      : typeof effectiveHeaders["x-agent-runtime"] === "string"
      ? String(effectiveHeaders["x-agent-runtime"])
      : "";

  const effectiveUrl = isCreate ? values!.url : eff("adapterConfig", "url", String(config.url ?? ""));

  const runtimeBadge =
    createRuntimeProfile === "http+crewai"
      ? "CrewAI profile"
      : createRuntimeProfile === "http+langgraph"
        ? "LangGraph profile"
        : "Custom HTTP profile";

  const commitRuntimeHint = (rawValue: string) => {
    if (isCreate) {
      set!({ httpRuntimeHeader: rawValue });
      return;
    }
    const nextValue = rawValue.trim();
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    if (nextValue) {
      nextHeaders["x-agent-runtime"] = nextValue;
    } else {
      delete nextHeaders["x-agent-runtime"];
    }
    mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
  };

  return (
    <>
      <Field label="Webhook URL" hint={help.webhookUrl}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="https://..."
        />
      </Field>

      <Field label="Runtime profile">
        <select
          className={inputClass}
          value={createRuntimeProfile}
          onChange={(event) => {
            const next = event.target.value as "custom-http" | "http+crewai" | "http+langgraph";
            if (isCreate) {
              set!({
                httpRuntimeProfile: next,
                ...(next === "http+crewai"
                  ? {
                      url: values!.url || "http://127.0.0.1:8000/webhook",
                      httpRuntimeHeader: "CrewAI",
                    }
                  : next === "http+langgraph"
                    ? { httpRuntimeHeader: "LangGraph" }
                    : {}),
              });
              return;
            }
            const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
            if (next === "http+crewai") nextHeaders["x-agent-runtime"] = "CrewAI";
            if (next === "http+langgraph") nextHeaders["x-agent-runtime"] = "LangGraph";
            if (next === "custom-http") {
              delete nextHeaders["x-agent-runtime"];
            }
            mark("adapterConfig", "runtimeProfile", next);
            mark("adapterConfig", "headers", Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined);
          }}
        >
          {profileOptions.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Runtime hint header (optional)">
        <DraftInput
          value={runtimeHint}
          onCommit={commitRuntimeHint}
          immediate
          className={inputClass}
          placeholder={createRuntimeProfile === "http+crewai" ? "CrewAI" : "LangGraph / custom"}
        />
      </Field>

      <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{runtimeBadge}</span>
        <span className="mx-1">-</span>
        <span>{effectiveUrl ? "Webhook configured" : "Missing webhook URL"}</span>
      </div>

    </>
  );
}
