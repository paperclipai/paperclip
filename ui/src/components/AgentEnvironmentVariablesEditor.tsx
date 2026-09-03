import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import type { EnvBinding } from "@paperclipai/shared";
import {
  EnvironmentVariablesEditor,
  type EnvironmentVariablesEditorHandle,
} from "./environment-variables-editor";

function isSecretBinding(binding: EnvBinding): boolean {
  return (
    typeof binding === "object" &&
    binding !== null &&
    (binding.type === "secret_ref" || binding.type === "user_secret_ref")
  );
}

/** Values that remain editable on the agent Configuration tab. */
export function selectAgentConfigurationEnv(
  value: Record<string, EnvBinding> | null | undefined,
): Record<string, EnvBinding> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, binding]) => !isSecretBinding(binding)),
  );
}

/** Keep hidden secret assignments intact while Configuration edits plain values. */
export function mergeAgentConfigurationEnv(
  current: Record<string, EnvBinding> | null | undefined,
  editable: Record<string, EnvBinding> | null | undefined,
): Record<string, EnvBinding> {
  const hiddenSecrets = Object.fromEntries(
    Object.entries(current ?? {}).filter(([, binding]) => isSecretBinding(binding)),
  );
  return { ...(editable ?? {}), ...hiddenSecrets };
}

/** Replace company-secret env refs while preserving plain and user-secret bindings. */
export function replaceAgentCompanySecretEnv(
  current: Record<string, EnvBinding> | null | undefined,
  secretBindings: Record<string, EnvBinding> | null | undefined,
): Record<string, EnvBinding> {
  const retained = Object.fromEntries(
    Object.entries(current ?? {}).filter(([, binding]) => {
      return !(typeof binding === "object" && binding !== null && binding.type === "secret_ref");
    }),
  );
  return { ...retained, ...(secretBindings ?? {}) };
}

interface AgentEnvironmentVariablesEditorProps {
  value: Record<string, EnvBinding>;
  onChange: (next: Record<string, EnvBinding> | undefined) => void;
  disabled?: boolean;
}

export const AgentEnvironmentVariablesEditor = forwardRef<
  EnvironmentVariablesEditorHandle,
  AgentEnvironmentVariablesEditorProps
>(function AgentEnvironmentVariablesEditor({ value, onChange, disabled }, ref) {
  const editorRef = useRef<EnvironmentVariablesEditorHandle | null>(null);
  const editableValue = useMemo(() => selectAgentConfigurationEnv(value), [value]);

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
      plainOnly
      footerHint="Plain environment values only. Assign secrets on the Secrets tab."
    />
  );
});
