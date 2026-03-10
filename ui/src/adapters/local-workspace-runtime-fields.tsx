import type { AdapterConfigFieldsProps } from "./types";
import { DraftInput, Field, help } from "../components/agent-config-primitives";
import { RuntimeServicesJsonField } from "./runtime-json-fields";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readWorkspaceStrategy(config: Record<string, unknown>) {
  const strategy = asRecord(config.workspaceStrategy);
  const type = asString(strategy.type) || "project_primary";
  return {
    type,
    baseRef: asString(strategy.baseRef),
    branchTemplate: asString(strategy.branchTemplate),
    worktreeParentDir: asString(strategy.worktreeParentDir),
  };
}

function buildWorkspaceStrategyPatch(input: {
  type: string;
  baseRef?: string;
  branchTemplate?: string;
  worktreeParentDir?: string;
}) {
  if (input.type !== "git_worktree") return undefined;
  return {
    type: "git_worktree",
    ...(input.baseRef ? { baseRef: input.baseRef } : {}),
    ...(input.branchTemplate ? { branchTemplate: input.branchTemplate } : {}),
    ...(input.worktreeParentDir ? { worktreeParentDir: input.worktreeParentDir } : {}),
  };
}

export function LocalWorkspaceRuntimeFields({
  isCreate,
  values,
  set,
  config,
  mark,
}: AdapterConfigFieldsProps) {
  const existing = readWorkspaceStrategy(config);
  const strategyType = isCreate ? values!.workspaceStrategyType ?? "project_primary" : existing.type;
  const updateEditWorkspaceStrategy = (patch: Partial<typeof existing>) => {
    const next = {
      ...existing,
      ...patch,
    };
    mark(
      "adapterConfig",
      "workspaceStrategy",
      buildWorkspaceStrategyPatch(next),
    );
  };
  return (
    <>
      <Field label="Workspace strategy" hint={help.workspaceStrategy}>
        <select
          className={inputClass}
          value={strategyType}
          onChange={(e) => {
            const nextType = e.target.value;
            if (isCreate) {
              set!({ workspaceStrategyType: nextType });
            } else {
              updateEditWorkspaceStrategy({ type: nextType });
            }
          }}
        >
          <option value="project_primary">Project primary workspace</option>
          <option value="git_worktree">Git worktree</option>
        </select>
      </Field>

      {strategyType === "git_worktree" && (
        <>
          <Field label="Base ref" hint={help.workspaceBaseRef}>
            <DraftInput
              value={isCreate ? values!.workspaceBaseRef ?? "" : existing.baseRef}
              onCommit={(v) =>
                isCreate
                  ? set!({ workspaceBaseRef: v })
                  : updateEditWorkspaceStrategy({ baseRef: v || "" })
              }
              immediate
              className={inputClass}
              placeholder="origin/main"
            />
          </Field>
          <Field label="Branch template" hint={help.workspaceBranchTemplate}>
            <DraftInput
              value={isCreate ? values!.workspaceBranchTemplate ?? "" : existing.branchTemplate}
              onCommit={(v) =>
                isCreate
                  ? set!({ workspaceBranchTemplate: v })
                  : updateEditWorkspaceStrategy({ branchTemplate: v || "" })
              }
              immediate
              className={inputClass}
              placeholder="{{issue.identifier}}-{{slug}}"
            />
          </Field>
          <Field label="Worktree parent dir" hint={help.worktreeParentDir}>
            <DraftInput
              value={isCreate ? values!.worktreeParentDir ?? "" : existing.worktreeParentDir}
              onCommit={(v) =>
                isCreate
                  ? set!({ worktreeParentDir: v })
                  : updateEditWorkspaceStrategy({ worktreeParentDir: v || "" })
              }
              immediate
              className={inputClass}
              placeholder=".paperclip/worktrees"
            />
          </Field>
        </>
      )}
      <RuntimeServicesJsonField
        isCreate={isCreate}
        values={values}
        set={set}
        config={config}
        mark={mark}
      />
    </>
  );
}
