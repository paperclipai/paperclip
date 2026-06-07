import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  ToggleField,
  DraftInput,
  DraftNumberInput,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Injected into the system prompt at runtime.";
const remoteSdkServerHint =
  "Optional ws:// or wss:// Paperclip Claude SDK server endpoint. When set, Paperclip uses the remote bridge over WebSocket instead of launching a local claude CLI process.";
const remoteSdkServerTokenHint =
  "Optional bearer token sent as Authorization during the Claude SDK server WebSocket handshake. Leave blank to connect without bearer auth.";

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
  onCommit: (value: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pr-8"}
          placeholder={placeholder}
        />
      </div>
    </Field>
  );
}

export function ClaudeLocalConfigFields({
  mode,
  isCreate,
  adapterType,
  values,
  set,
  config,
  eff,
  mark,
  models,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const configuredHeaders =
    config.agentSdkServerHeaders &&
    typeof config.agentSdkServerHeaders === "object" &&
    !Array.isArray(config.agentSdkServerHeaders)
      ? (config.agentSdkServerHeaders as Record<string, unknown>)
      : {};
  const effectiveHeaders =
    (eff("adapterConfig", "agentSdkServerHeaders", configuredHeaders) as Record<string, unknown>) ?? {};
  const effectiveAuthorization =
    typeof effectiveHeaders.Authorization === "string" ? effectiveHeaders.Authorization : "";
  const effectiveBearerToken =
    isCreate
      ? values!.appServerBearerToken ?? ""
      : typeof config.agentSdkServerBearerToken === "string"
        ? eff("adapterConfig", "agentSdkServerBearerToken", String(config.agentSdkServerBearerToken))
        : effectiveAuthorization.startsWith("Bearer ")
          ? effectiveAuthorization.slice("Bearer ".length)
          : "";

  const commitBearerToken = (rawValue: string) => {
    const nextValue = rawValue.trim();
    if (isCreate) {
      set!({ appServerBearerToken: nextValue });
      return;
    }

    mark("adapterConfig", "agentSdkServerBearerToken", nextValue || undefined);
    if (!effectiveAuthorization.startsWith("Bearer ")) return;
    const nextHeaders: Record<string, unknown> = { ...effectiveHeaders };
    delete nextHeaders.Authorization;
    mark(
      "adapterConfig",
      "agentSdkServerHeaders",
      Object.keys(nextHeaders).length > 0 ? nextHeaders : undefined,
    );
  };

  return (
    <>
      <Field label="Remote SDK Server URL" hint={remoteSdkServerHint}>
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff(
                  "adapterConfig",
                  "agentSdkServerUrl",
                  String(config.agentSdkServerUrl ?? ""),
                )
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "agentSdkServerUrl", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="ws://claude-host:4400"
        />
      </Field>
      <SecretField
        label="Remote SDK Server bearer token"
        hint={remoteSdkServerTokenHint}
        value={effectiveBearerToken}
        onCommit={commitBearerToken}
        placeholder="Leave blank for no bearer auth"
      />
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

export function ClaudeLocalAdvancedFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  return (
    <>
      <ToggleField
        label="Enable Chrome"
        hint={help.chrome}
        checked={
          isCreate
            ? values!.chrome
            : eff("adapterConfig", "chrome", config.chrome === true)
        }
        onChange={(v) =>
          isCreate
            ? set!({ chrome: v })
            : mark("adapterConfig", "chrome", v)
        }
      />
      <ToggleField
        label="Skip permissions"
        hint={help.dangerouslySkipPermissions}
        checked={
          isCreate
            ? values!.dangerouslySkipPermissions
            : eff(
                "adapterConfig",
                "dangerouslySkipPermissions",
                config.dangerouslySkipPermissions !== false,
              )
        }
        onChange={(v) =>
          isCreate
            ? set!({ dangerouslySkipPermissions: v })
            : mark("adapterConfig", "dangerouslySkipPermissions", v)
        }
      />
      <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxTurnsPerRun}
            onChange={(e) => set!({ maxTurnsPerRun: Number(e.target.value) })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxTurnsPerRun",
              Number(config.maxTurnsPerRun ?? 1000),
            )}
            onCommit={(v) => mark("adapterConfig", "maxTurnsPerRun", v || 1000)}
            immediate
            className={inputClass}
          />
        )}
      </Field>
    </>
  );
}
