import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { syncRoutineVariablesWithTemplate, type RoutineVariable } from "@paperclipai/shared";
import { Input, Select, ListBox } from "@heroui/react";

const variableTypes: RoutineVariable["type"][] = ["text", "textarea", "number", "boolean", "select"];

function serializeVariables(value: RoutineVariable[]) {
  return JSON.stringify(value);
}

function parseSelectOptions(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function updateVariableList(
  variables: RoutineVariable[],
  name: string,
  mutate: (variable: RoutineVariable) => RoutineVariable,
) {
  return variables.map((variable) => (variable.name === name ? mutate(variable) : variable));
}

export function RoutineVariablesEditor({
  description,
  value,
  onChange,
}: {
  description: string;
  value: RoutineVariable[];
  onChange: (value: RoutineVariable[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const syncedVariables = useMemo(
    () => syncRoutineVariablesWithTemplate(description, value),
    [description, value],
  );
  const syncedSignature = serializeVariables(syncedVariables);
  const currentSignature = serializeVariables(value);

  useEffect(() => {
    if (syncedSignature !== currentSignature) {
      onChange(syncedVariables);
    }
  }, [currentSignature, onChange, syncedSignature, syncedVariables]);

  if (syncedVariables.length === 0) {
    return null;
  }

  return (
    <div>
      <button
        type="button"
        className="flex w-full items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <p className="text-sm font-medium">Variables</p>
          <p className="text-xs text-muted-foreground">
            Detected from `{"{{name}}"}` placeholders in the routine instructions.
          </p>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="space-y-3 pt-3">
        {syncedVariables.map((variable) => (
          <div key={variable.name} className="rounded-lg border border-border/70 p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono text-xs">
                {`{{${variable.name}}}`}
              </span>
              <span className="text-xs text-muted-foreground">
                Prompt the user for this value before each manual run.
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Label</label>
                <Input
                  value={variable.label ?? ""}
                  onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    label: event.target.value || null,
                  })))}
                  placeholder={variable.name.replaceAll("_", " ")}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Type</label>
                <Select
                  selectedKey={variable.type}
                  onSelectionChange={(type) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    type: type as RoutineVariable["type"],
                    defaultValue: type === "boolean" ? null : current.defaultValue,
                    options: type === "select" ? current.options : [],
                  })))}
                >
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                    <ListBox>
                      {variableTypes.map((type) => (
                        <ListBox.Item key={type} id={type}>{type}</ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <label className="text-xs text-muted-foreground">Default value</label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                        ...current,
                        required: event.target.checked,
                      })))}
                    />
                    Required
                  </label>
                </div>

                {variable.type === "textarea" ? (
                  <textarea
                    rows={3}
                    className="w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm resize-none"
                    value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                  />
                ) : variable.type === "boolean" ? (
                  <Select
                    selectedKey={variable.defaultValue === true ? "true" : variable.defaultValue === false ? "false" : "__unset__"}
                    onSelectionChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: next === "__unset__" ? null : next === "true",
                    })))}
                  >
                    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                    <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                      <ListBox>
                        <ListBox.Item id="__unset__">No default</ListBox.Item>
                        <ListBox.Item id="true">True</ListBox.Item>
                        <ListBox.Item id="false">False</ListBox.Item>
                      </ListBox>
                    </Select.Popover>
                  </Select>
                ) : variable.type === "select" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground">Options</label>
                      <Input
                        value={variable.options.join(", ")}
                        onChange={(event) => {
                          const options = parseSelectOptions(event.target.value);
                          onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                            ...current,
                            options,
                            defaultValue:
                              typeof current.defaultValue === "string" && options.includes(current.defaultValue)
                                ? current.defaultValue
                                : null,
                          })));
                        }}
                        placeholder="high, medium, low"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground">Default option</label>
                      <Select
                        selectedKey={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                        onSelectionChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                          ...current,
                          defaultValue: next === "__unset__" ? null : next,
                        })))}
                      >
                        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                        <Select.Popover placement="bottom" className="max-h-60 overflow-y-auto">
                          <ListBox>
                            <ListBox.Item id="__unset__">No default</ListBox.Item>
                            {variable.options.map((option) => (
                              <ListBox.Item key={option} id={option}>{option}</ListBox.Item>
                            ))}
                          </ListBox>
                        </Select.Popover>
                      </Select>
                    </div>
                  </div>
                ) : (
                  <Input
                    type={variable.type === "number" ? "number" : "text"}
                    value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                    placeholder={variable.type === "number" ? "42" : "Default value"}
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </div>}
    </div>
  );
}

export function RoutineVariablesHint() {
  return (
    <div className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
      Use `{"{{variable_name}}"}` placeholders in the instructions to prompt for inputs when the routine runs.
    </div>
  );
}
