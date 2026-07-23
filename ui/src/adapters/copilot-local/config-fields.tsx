import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  DraftNumberInput,
  Field,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";
import { LocalWorkspaceRuntimeFields } from "../local-workspace-runtime-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function CopilotLocalConfigFields({
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
  return (
    <>
      <Field
        label="ACP server command"
        hint="Optional full command override. Paperclip otherwise starts copilot --acp --stdio with managed automation flags."
      >
        <DraftInput
          value={
            isCreate
              ? values!.copilotAcpAgentCommand ?? ""
              : eff("adapterConfig", "agentCommand", String(config.agentCommand ?? ""))
          }
          onCommit={(value) =>
            isCreate
              ? set!({ copilotAcpAgentCommand: value })
              : mark("adapterConfig", "agentCommand", value || undefined)
          }
          immediate
          className={inputClass}
          placeholder="copilot --acp --stdio"
        />
      </Field>

      <Field
        label="ACP session mode"
        hint="Persistent retains the Copilot session between heartbeats. One-shot starts fresh."
      >
        <select
          className={inputClass}
          value={
            isCreate
              ? values!.copilotAcpMode ?? "persistent"
              : eff("adapterConfig", "mode", String(config.mode ?? "persistent"))
          }
          onChange={(event) => {
            const value = event.target.value === "oneshot" ? "oneshot" : "persistent";
            isCreate
              ? set!({ copilotAcpMode: value })
              : mark("adapterConfig", "mode", value);
          }}
        >
          <option value="persistent">Persistent</option>
          <option value="oneshot">One-shot</option>
        </select>
      </Field>

      <Field
        label="ACP permission mode"
        hint="Controls how Paperclip answers Copilot tool permission requests."
      >
        <select
          className={inputClass}
          value={
            isCreate
              ? values!.copilotAcpPermissionMode ?? "approve-all"
              : eff(
                  "adapterConfig",
                  "permissionMode",
                  String(config.permissionMode ?? "approve-all"),
                )
          }
          onChange={(event) => {
            const value =
              event.target.value === "approve-reads"
                ? "approve-reads"
                : event.target.value === "deny-all"
                  ? "deny-all"
                  : "approve-all";
            isCreate
              ? set!({ copilotAcpPermissionMode: value })
              : mark("adapterConfig", "permissionMode", value);
          }}
        >
          <option value="approve-all">Approve all</option>
          <option value="approve-reads">Approve reads</option>
          <option value="deny-all">Deny all</option>
        </select>
      </Field>

      <Field
        label="ACP non-interactive permissions"
        hint="Fallback when Copilot requests input outside an interactive session."
      >
        <select
          className={inputClass}
          value={
            isCreate
              ? values!.copilotAcpNonInteractivePermissions ?? "deny"
              : eff(
                  "adapterConfig",
                  "nonInteractivePermissions",
                  String(config.nonInteractivePermissions ?? "deny"),
                )
          }
          onChange={(event) => {
            const value = event.target.value === "fail" ? "fail" : "deny";
            isCreate
              ? set!({ copilotAcpNonInteractivePermissions: value })
              : mark("adapterConfig", "nonInteractivePermissions", value);
          }}
        >
          <option value="deny">Deny</option>
          <option value="fail">Fail</option>
        </select>
      </Field>

      <Field
        label="ACP state directory"
        hint="Optional runtime state directory. Defaults to Paperclip-managed agent storage."
      >
        <div className="flex items-center gap-2">
          <DraftInput
            value={
              isCreate
                ? values!.copilotAcpStateDir ?? ""
                : eff("adapterConfig", "stateDir", String(config.stateDir ?? ""))
            }
            onCommit={(value) =>
              isCreate
                ? set!({ copilotAcpStateDir: value })
                : mark("adapterConfig", "stateDir", value || undefined)
            }
            immediate
            className={inputClass}
            placeholder="/path/to/copilot-acp-state"
          />
          <ChoosePathButton />
        </div>
      </Field>

      <Field
        label="ACP warm process idle ms"
        hint="Defaults to 0, closing the process after each run while retaining session state."
      >
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.copilotAcpWarmHandleIdleMs ?? 0}
            onChange={(event) =>
              set!({ copilotAcpWarmHandleIdleMs: Number(event.target.value) })
            }
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "warmHandleIdleMs",
              Number(config.warmHandleIdleMs ?? 0),
            )}
            onCommit={(value) => mark("adapterConfig", "warmHandleIdleMs", value || 0)}
            immediate
            className={inputClass}
          />
        )}
      </Field>

      {!hideInstructionsFile && (
        <Field
          label="Agent instructions file"
          hint="Absolute markdown file prepended to every Copilot heartbeat prompt."
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
              onCommit={(value) =>
                isCreate
                  ? set!({ instructionsFilePath: value })
                  : mark("adapterConfig", "instructionsFilePath", value || undefined)
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
