import type { AdapterConfigFieldsProps } from "../types";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { useCompany } from "../../context/CompanyContext";
import {
  Field,
  DraftInput,
  ToggleField,
  help,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const selectClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40 appearance-none cursor-pointer";

export function HybridLocalConfigFields(props: AdapterConfigFieldsProps) {
  const { isCreate, config, eff, mark, models, values, set } = props;
  const { selectedCompanyId } = useCompany();

  const { data: claudeModels = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModels(selectedCompanyId, "claude_local")
      : ["agents", "none", "adapter-models", "claude_local"],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, "claude_local"),
    enabled: Boolean(selectedCompanyId),
  });

  const { data: codexModels = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.agents.adapterModels(selectedCompanyId, "codex_local")
      : ["agents", "none", "adapter-models", "codex_local"],
    queryFn: () => agentsApi.adapterModels(selectedCompanyId!, "codex_local"),
    enabled: Boolean(selectedCompanyId),
  });

  const codingModels = useMemo(() => {
    const combined = [...claudeModels, ...codexModels];
    const seen = new Set<string>();
    return combined.filter((model) => {
      if (seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }, [claudeModels, codexModels]);

  if (isCreate) {
    return (
      <>
        {/* Reuse all Claude config fields (model, cwd, instructions, workspace, etc.) */}
        <ClaudeLocalConfigFields {...props} models={models} />
        <Field
          label="Hybrid extras"
          hint="Local endpoint URL, coding model, and routing options can be configured after creating the agent."
        >
          <div className="text-xs text-muted-foreground">
            Save the agent first, then edit it to configure hybrid-specific routing fields.
          </div>
        </Field>
      </>
    );
  }

  return (
    <>
      {/* Reuse all Claude config fields (model, cwd, instructions, workspace, etc.) */}
      <ClaudeLocalConfigFields {...props} models={models} />

      <Field
        label="Local endpoint URL"
        hint="OpenAI-compatible API endpoint. Defaults to Ollama on 11434 (LM Studio: 1234, LiteLLM: 4000)"
      >
        <DraftInput
          value={
            eff(
              "adapterConfig",
              "localBaseUrl",
              String(config.localBaseUrl ?? "http://127.0.0.1:11434/v1"),
            )
          }
          onCommit={(v) => mark("adapterConfig", "localBaseUrl", v || undefined)}
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:11434/v1"
        />
      </Field>

      <Field
        label="Quota threshold %"
        hint="Block Claude coding when quota exceeds this %. Default: 80. Set to 0 to disable."
      >
        <input
          type="number"
          min={0}
          max={100}
          className={inputClass}
          value={
            eff("adapterConfig", "quotaThresholdPercent", Number(config.quotaThresholdPercent ?? 80))
          }
          onChange={(e) => {
            const v = Number(e.target.value);
            mark("adapterConfig", "quotaThresholdPercent", v);
          }}
        />
      </Field>

      <Field
        label="Max total tokens"
        hint={help.maxTotalTokens}
      >
        {isCreate ? (
          <input
            type="number"
            min={1}
            className={inputClass}
            value={props.values!.maxTotalTokens}
            onChange={(e) => props.set!({ maxTotalTokens: Number(e.target.value) })}
          />
        ) : (
          <DraftInput
            value={String(
              eff(
                "adapterConfig",
                "maxTotalTokens",
                Number(config.maxTotalTokens ?? 300000),
              ),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTotalTokens", Number(v) || 300000)}
            immediate
            className={inputClass}
            placeholder="300000"
          />
        )}
      </Field>

      <ToggleField
        label="Allow extra credit"
        hint="When off (recommended), Claude is blocked once quota reaches the threshold and Paperclip fails closed if quota status is unavailable."
        checked={
          eff("adapterConfig", "allowExtraCredit", config.allowExtraCredit === true)
        }
        onChange={(v) => mark("adapterConfig", "allowExtraCredit", v)}
      />

      <Field label="Local tool access" hint={help.localToolMode}>
        <select
          className={selectClass}
          value={
            isCreate
              ? (values!.localToolMode ?? "read_only")
              : eff(
                  "adapterConfig",
                  "localToolMode",
                  typeof config.localToolMode === "string" && config.localToolMode.trim().length > 0
                    ? config.localToolMode
                    : (config.allowLocalTools === true ? "full" : "off"),
                )
          }
          onChange={(e) => {
            const v = e.target.value as "off" | "read_only" | "full";
            if (isCreate) {
              set!({ localToolMode: v });
            } else {
              mark("adapterConfig", "localToolMode", v);
            }
          }}
        >
          <option value="off">Off (no tools)</option>
          <option value="read_only">Read-only (ls, rg, cat, git status)</option>
          <option value="full">Full (allow writes)</option>
        </select>
      </Field>

      <Field
        label="Coding model"
        hint={help.codingModel}
      >
        <select
          className={selectClass}
          value={
            isCreate
              ? values!.codingModel ?? ""
              : eff("adapterConfig", "codingModel", String(config.codingModel ?? ""))
          }
          onChange={(e) => {
            const v = e.target.value;
            if (isCreate) {
              set!({ codingModel: v });
            } else {
              mark("adapterConfig", "codingModel", v === "" ? null : v);
            }
          }}
        >
          <option value="">None (no coding model)</option>
          {codingModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
    </>
  );
}
