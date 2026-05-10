import { useEffect, useState } from "react";
import type { AdapterConfigFieldsProps } from "./types";
import { Field, help } from "../components/agent-config-primitives";

// TODO(issue-worktree-support): re-enable this UI once the workflow is ready to ship.
const SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = false;

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

function updateJsonConfig(
  isCreate: boolean,
  key: "runtimeServicesJson" | "payloadTemplateJson",
  next: string,
  set: AdapterConfigFieldsProps["set"],
  mark: AdapterConfigFieldsProps["mark"],
  configKey: string,
) {
  if (isCreate) {
    set?.({ [key]: next });
    return;
  }

  const trimmed = next.trim();
  if (!trimmed) {
    mark("adapterConfig", configKey, undefined);
    return;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      mark("adapterConfig", configKey, parsed);
    }
  } catch {
    // Keep local draft until JSON is valid.
  }
}

type JsonFieldProps = Pick<
  AdapterConfigFieldsProps,
  "isCreate" | "values" | "set" | "config" | "mark"
>;

export function RuntimeServicesJsonField({
  isCreate,
  values,
  set,
  config,
  mark,
}: JsonFieldProps) {
  if (!SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI) {
    return null;
  }

  const existing = formatJsonObject(config.workspaceRuntime);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? values?.runtimeServicesJson ?? "" : draft;

  return (
    <Field label="Runtime services JSON" hint={help.runtimeServicesJson}>
      <textarea
        className={`${inputClass} min-h-[148px]`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (!isCreate) setDraft(next);
          updateJsonConfig(isCreate, "runtimeServicesJson", next, set, mark, "workspaceRuntime");
        }}
        placeholder={`{\n  "services": [\n    {\n      "name": "preview",\n      "lifecycle": "ephemeral",\n      "metadata": {\n        "purpose": "remote preview"\n      }\n    }\n  ]\n}`}
      />
    </Field>
  );
}

export function PayloadTemplateJsonField({
  isCreate,
  values,
  set,
  config,
  mark,
}: JsonFieldProps) {
  const existing = formatJsonObject(config.payloadTemplate);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? values?.payloadTemplateJson ?? "" : draft;

  return (
    <Field label="Payload template JSON" hint={help.payloadTemplateJson}>
      <textarea
        className={`${inputClass} min-h-[132px]`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (!isCreate) setDraft(next);
          updateJsonConfig(isCreate, "payloadTemplateJson", next, set, mark, "payloadTemplate");
        }}
        placeholder={`{\n  "agentId": "remote-agent-123",\n  "metadata": {\n    "team": "platform"\n  }\n}`}
      />
    </Field>
  );
}
