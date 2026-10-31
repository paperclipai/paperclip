import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import type { EnvBinding } from "@paperclipai/shared";
import {
  EnvironmentVariablesEditor,
  type EnvironmentVariablesEditorHandle,
  type EnvironmentVariablesEditorProps,
} from "./environment-variables-editor";

function isHiddenBinding(binding: EnvBinding): boolean {
  if (binding === "***REDACTED***") return true;
  return (
    typeof binding === "object" &&
    binding !== null &&
    (binding.type === "secret_ref" || binding.type === "user_secret_ref" ||
      (binding.type === "plain" && binding.value === "***REDACTED***"))
  );
}

/** Values that remain editable on the agent Configuration tab. */
export function selectAgentConfigurationEnv(
  value: Record<string, EnvBinding> | null | undefined,
): Record<string, EnvBinding> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, binding]) => !isHiddenBinding(binding)),
  );
}

/** Keep hidden secret assignments intact while Configuration edits plain values. */
export function mergeAgentConfigurationEnv(
  current: Record<string, EnvBinding> | null | undefined,
  editable: Record<string, EnvBinding> | null | undefined,
): Record<string, EnvBinding> {
  const hiddenSecrets = Object.fromEntries(
    Object.entries(current ?? {}).filter(([, binding]) => isHiddenBinding(binding)),
  );
  return { ...(editable ?? {}), ...hiddenSecrets };
}

type AgentEnvironmentVariablesEditorProps = Omit<EnvironmentVariablesEditorProps, "secrets" | "onCreateSecret"> &
  Partial<Pick<EnvironmentVariablesEditorProps, "secrets" | "onCreateSecret">>;

export const AgentEnvironmentVariablesEditor = forwardRef<
  EnvironmentVariablesEditorHandle,
  AgentEnvironmentVariablesEditorProps
>(function AgentEnvironmentVariablesEditor({ value, onChange, disabled, onDirtyChange, hideDraftActions }, ref) {
  const editorRef = useRef<EnvironmentVariablesEditorHandle | null>(null);
  const editableValue = useMemo(() => selectAgentConfigurationEnv(value), [value]);
  const secretNames = useMemo(
    () => Object.entries(value ?? {}).filter(([, binding]) => isHiddenBinding(binding)).map(([name]) => name),
    [value],
  );

  function emitEditable(next: Record<string, EnvBinding> | undefined) {
    onChange(mergeAgentConfigurationEnv(value, next));
  }

  useImperativeHandle(ref, () => ({
    flushPendingDraft() {
      const editableDraft = editorRef.current?.flushPendingDraft() ?? null;
      return editableDraft ? mergeAgentConfigurationEnv(value, editableDraft) : null;
    },
  }), [value]);

  return (
    <EnvironmentVariablesEditor
      ref={editorRef}
      value={editableValue}
      onChange={emitEditable}
      secrets={[]}
      onCreateSecret={async () => {
        throw new Error("Secret assignment is available on the Secrets tab");
      }}
      disabled={disabled}
      onDirtyChange={onDirtyChange}
      hideDraftActions={hideDraftActions}
      plainOnly
      takenNames={secretNames}
      footerHint="Plain environment values only. Assign secrets on the Secrets tab."
    />
  );
});
