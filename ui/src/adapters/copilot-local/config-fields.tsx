import { useEffect, useState } from "react";
import type { AdapterConfigFieldsProps } from "../types";
import {
  DraftInput,
  DraftNumberInput,
  Field,
  ToggleField,
  help,
} from "../../components/agent-config-primitives";
import { ChoosePathButton } from "../../components/PathInstructionsModal";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";
const instructionsFileHint =
  "Absolute path to a markdown file (e.g. AGENTS.md) that defines this agent's behavior. Prepended to the Copilot prompt at runtime.";
const autopilotHint = "Enable Copilot autopilot mode for multi-step work.";
const experimentalHint = "Enable Copilot experimental features.";
const reasoningSummaryHint = "Request reasoning summaries from supported models.";
const maxAutopilotContinuesHint =
  "Maximum number of continuation messages Copilot can use while in autopilot mode. 0 means unlimited.";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatJsonObject(value: unknown): string {
  const record = asRecord(value);
  return Object.keys(record).length > 0 ? JSON.stringify(record, null, 2) : "";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readWorkspaceStrategy(config: Record<string, unknown>) {
  const strategy = asRecord(config.workspaceStrategy);
  const type = strategy.type === "git_worktree" ? "git_worktree" : "project_primary";
  return {
    type,
    baseRef: typeof strategy.baseRef === "string" ? strategy.baseRef : "",
    branchTemplate: typeof strategy.branchTemplate === "string" ? strategy.branchTemplate : "",
    worktreeParentDir: typeof strategy.worktreeParentDir === "string" ? strategy.worktreeParentDir : "",
  };
}

export function CopilotLocalConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
  hideInstructionsFile,
}: AdapterConfigFieldsProps) {
  const existingStrategy = readWorkspaceStrategy(config);
  const [editStrategyType, setEditStrategyType] = useState(existingStrategy.type);
  const [editBaseRef, setEditBaseRef] = useState(existingStrategy.baseRef);
  const [editBranchTemplate, setEditBranchTemplate] = useState(existingStrategy.branchTemplate);
  const [editWorktreeParentDir, setEditWorktreeParentDir] = useState(existingStrategy.worktreeParentDir);
  const [runtimeServicesDraft, setRuntimeServicesDraft] = useState(formatJsonObject(config.workspaceRuntime));

  useEffect(() => {
    if (isCreate) return;
    const next = readWorkspaceStrategy(config);
    setEditStrategyType(next.type);
    setEditBaseRef(next.baseRef);
    setEditBranchTemplate(next.branchTemplate);
    setEditWorktreeParentDir(next.worktreeParentDir);
    setRuntimeServicesDraft(formatJsonObject(config.workspaceRuntime));
  }, [config, isCreate]);

  function commitEditStrategy(
    next: Partial<{
      type: "project_primary" | "git_worktree";
      baseRef: string;
      branchTemplate: string;
      worktreeParentDir: string;
    }>,
  ) {
    const merged = {
      type: editStrategyType,
      baseRef: editBaseRef,
      branchTemplate: editBranchTemplate,
      worktreeParentDir: editWorktreeParentDir,
      ...next,
    };
    setEditStrategyType(merged.type);
    setEditBaseRef(merged.baseRef);
    setEditBranchTemplate(merged.branchTemplate);
    setEditWorktreeParentDir(merged.worktreeParentDir);
    mark(
      "adapterConfig",
      "workspaceStrategy",
      merged.type === "git_worktree"
        ? {
            type: "git_worktree",
            ...(merged.baseRef ? { baseRef: merged.baseRef } : {}),
            ...(merged.branchTemplate ? { branchTemplate: merged.branchTemplate } : {}),
            ...(merged.worktreeParentDir ? { worktreeParentDir: merged.worktreeParentDir } : {}),
          }
        : undefined,
    );
  }

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
      <ToggleField
        label="Autopilot"
        hint={autopilotHint}
        checked={
          isCreate
            ? values!.autopilot !== false
            : eff("adapterConfig", "autopilot", config.autopilot !== false)
        }
        onChange={(v) =>
          isCreate
            ? set!({ autopilot: v })
            : mark("adapterConfig", "autopilot", v)
        }
      />
      <ToggleField
        label="Experimental features"
        hint={experimentalHint}
        checked={
          isCreate
            ? Boolean(values!.experimental)
            : eff("adapterConfig", "experimental", Boolean(config.experimental))
        }
        onChange={(v) =>
          isCreate
            ? set!({ experimental: v })
            : mark("adapterConfig", "experimental", v)
        }
      />
      <ToggleField
        label="Reasoning summaries"
        hint={reasoningSummaryHint}
        checked={
          isCreate
            ? Boolean(values!.enableReasoningSummaries)
            : eff("adapterConfig", "enableReasoningSummaries", Boolean(config.enableReasoningSummaries))
        }
        onChange={(v) =>
          isCreate
            ? set!({ enableReasoningSummaries: v })
            : mark("adapterConfig", "enableReasoningSummaries", v)
        }
      />
      <Field label="Max autopilot continues" hint={maxAutopilotContinuesHint}>
        {isCreate ? (
          <input
            type="number"
            className={inputClass}
            value={values!.maxAutopilotContinues ?? 0}
            min={0}
            onChange={(e) => set!({ maxAutopilotContinues: Number(e.target.value) || 0 })}
          />
        ) : (
          <DraftNumberInput
            value={eff(
              "adapterConfig",
              "maxAutopilotContinues",
              Number(config.maxAutopilotContinues ?? 0),
            )}
            onCommit={(v) => mark("adapterConfig", "maxAutopilotContinues", Math.max(0, v || 0))}
            immediate
            className={inputClass}
          />
        )}
      </Field>
      <Field label="Execution workspace" hint={help.workspaceStrategy}>
        {isCreate ? (
          <select
            className={inputClass}
            value={values!.workspaceStrategyType ?? "project_primary"}
            onChange={(e) => set!({ workspaceStrategyType: e.target.value })}
          >
            <option value="project_primary">Project primary</option>
            <option value="git_worktree">Git worktree</option>
          </select>
        ) : (
          <select
            className={inputClass}
            value={editStrategyType}
            onChange={(e) =>
              commitEditStrategy({
                type: e.target.value === "git_worktree" ? "git_worktree" : "project_primary",
              })
            }
          >
            <option value="project_primary">Project primary</option>
            <option value="git_worktree">Git worktree</option>
          </select>
        )}
      </Field>
      {(isCreate
        ? values!.workspaceStrategyType === "git_worktree"
        : editStrategyType === "git_worktree") && (
        <>
          <Field label="Workspace base ref" hint={help.workspaceBaseRef}>
            <DraftInput
              value={isCreate ? values!.workspaceBaseRef ?? "" : editBaseRef}
              onCommit={(v) =>
                isCreate
                  ? set!({ workspaceBaseRef: v })
                  : commitEditStrategy({ baseRef: v })
              }
              immediate
              className={inputClass}
              placeholder="origin/main"
            />
          </Field>
          <Field label="Workspace branch template" hint={help.workspaceBranchTemplate}>
            <DraftInput
              value={isCreate ? values!.workspaceBranchTemplate ?? "" : editBranchTemplate}
              onCommit={(v) =>
                isCreate
                  ? set!({ workspaceBranchTemplate: v })
                  : commitEditStrategy({ branchTemplate: v })
              }
              immediate
              className={inputClass}
              placeholder="{{issue.identifier}}-{{slug}}"
            />
          </Field>
          <Field label="Worktree parent dir" hint={help.worktreeParentDir}>
            <DraftInput
              value={isCreate ? values!.worktreeParentDir ?? "" : editWorktreeParentDir}
              onCommit={(v) =>
                isCreate
                  ? set!({ worktreeParentDir: v })
                  : commitEditStrategy({ worktreeParentDir: v })
              }
              immediate
              className={inputClass}
              placeholder=".paperclip/worktrees"
            />
          </Field>
        </>
      )}
      <Field label="Runtime services JSON" hint={help.runtimeServicesJson}>
        <textarea
          className={`${inputClass} min-h-[132px]`}
          value={isCreate ? values!.runtimeServicesJson ?? "" : runtimeServicesDraft}
          onChange={(e) => {
            const next = e.target.value;
            if (isCreate) {
              set!({ runtimeServicesJson: next });
              return;
            }
            setRuntimeServicesDraft(next);
            const trimmed = next.trim();
            if (!trimmed) {
              mark("adapterConfig", "workspaceRuntime", undefined);
              return;
            }
            const parsed = parseJsonObject(trimmed);
            if (parsed && Array.isArray(parsed.services)) {
              mark("adapterConfig", "workspaceRuntime", parsed);
            }
          }}
          placeholder={`{\n  "services": [\n    {\n      "name": "preview"\n    }\n  ]\n}`}
        />
      </Field>
    </>
  );
}
