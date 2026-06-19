import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, HelpCircle, Plus, Trash2 } from "lucide-react";
import {
  extractRoutineVariableNames,
  isBuiltinRoutineVariable,
  isValidRoutineVariableName,
  reconcileRoutineVariablesWithTemplate,
  syncRoutineVariablesWithTemplate,
  type RoutineVariable,
} from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const variableTypes: RoutineVariable["type"][] = ["text", "textarea", "number", "boolean", "select"];
const MANUAL_VARIABLE_SOURCE = "manual";
const ROUTINE_VARIABLE_MATCHER = /\{\{\s*([A-Za-z](?:\\_|[A-Za-z0-9_])*)\s*\}\}/g;
type EditableRoutineVariable = RoutineVariable & { source?: typeof MANUAL_VARIABLE_SOURCE };

function normalizeTemplateVariableName(name: string) {
  return name.replace(/\\_/g, "_");
}

function stripResolvedTemplateVariables(template: string, resolvedNames: Set<string>) {
  if (resolvedNames.size === 0) return template;
  return template.replace(ROUTINE_VARIABLE_MATCHER, (match, rawName: string) =>
    resolvedNames.has(normalizeTemplateVariableName(rawName)) ? "" : match
  );
}

function serializeVariables(value: RoutineVariable[]) {
  return JSON.stringify(value);
}

function setSignature(value: Set<string>) {
  return [...value].sort().join("\n");
}

function variableNameSet(value: RoutineVariable[]) {
  return new Set(value.map((variable) => variable.name));
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

function updateVariableName(variables: RoutineVariable[], name: string, nextName: string) {
  const normalizedName = nextName.trim();
  if (!isValidRoutineVariableName(normalizedName)) return variables;
  if (variables.some((variable) => variable.name !== name && variable.name === normalizedName)) return variables;
  return variables.map((variable) => (variable.name === name ? { ...variable, name: normalizedName } : variable));
}

function removeVariable(variables: RoutineVariable[], name: string) {
  return variables.filter((variable) => variable.name !== name);
}

function manualVariableName(variables: RoutineVariable[]) {
  const existingNames = new Set(variables.map((variable) => variable.name));
  for (let index = 1; index < 1000; index += 1) {
    const candidate = index === 1 ? "field" : `field_${index}`;
    if (!existingNames.has(candidate)) return candidate;
  }
  return `field_${Date.now().toString(36)}`;
}

function defaultManualVariable(variables: RoutineVariable[]): RoutineVariable {
  return {
    name: manualVariableName(variables),
    label: null,
    type: "text",
    defaultValue: null,
    required: false,
    options: [],
    source: MANUAL_VARIABLE_SOURCE,
  } as EditableRoutineVariable;
}

function markManualVariables(variables: RoutineVariable[], manualVariableNames: Set<string>): RoutineVariable[] {
  return variables.map((variable) =>
    manualVariableNames.has(variable.name)
      ? ({ ...variable, source: MANUAL_VARIABLE_SOURCE } as EditableRoutineVariable)
      : variable,
  );
}

function manualVariableNameSet(value: RoutineVariable[], templateNames: Set<string>) {
  return new Set(
    value
      .filter((variable) =>
        (variable as EditableRoutineVariable).source === MANUAL_VARIABLE_SOURCE ||
        !templateNames.has(variable.name)
      )
      .map((variable) => variable.name),
  );
}

function updateManualVariableNameSet(current: Set<string>, name: string, nextName: string) {
  const next = new Set(current);
  next.delete(name);
  next.add(nextName);
  return next;
}

function pruneManualVariableNameSet(current: Set<string>, existingNames: Set<string>) {
  const next = new Set([...current].filter((name) => existingNames.has(name)));
  return setSignature(next) === setSignature(current) ? current : next;
}

function removeManualVariableName(current: Set<string>, name: string) {
  const next = new Set(current);
  next.delete(name);
  return next;
}

function addManualVariableName(current: Set<string>, name: string) {
  return new Set([...current, name]);
}

function unmarkVariable(variable: RoutineVariable): RoutineVariable {
  const { source: _source, ...rest } = variable as EditableRoutineVariable;
  return rest;
}

function unmarkVariables(variables: RoutineVariable[]): RoutineVariable[] {
  return variables.map(unmarkVariable);
}

function stripVariablesByName(variables: RoutineVariable[], names: Set<string>): RoutineVariable[] {
  if (names.size === 0) return variables;
  return variables.filter((variable) => !names.has(variable.name));
}

function editableVariables(variables: RoutineVariable[], manualVariableNames: Set<string>): RoutineVariable[] {
  return markManualVariables(variables, manualVariableNames);
}

function syncVariables(
  templates: Array<string | null | undefined>,
  existing: RoutineVariable[],
  manualVariableNames: Iterable<string>,
) {
  return reconcileRoutineVariablesWithTemplate(templates, existing, { manualVariableNames });
}

export function RoutineVariablesEditor({
  title,
  description,
  value,
  onChange,
  preserveUnmatchedVariables = false,
  allowManualVariables = false,
  manualVariableNamesSeed,
  heading = "Variables",
  descriptionText = 'Detected from `{{name}}` placeholders in the routine title and instructions.',
  emptyMessage = null,
  addButtonLabel = "Add variable",
  resolvedTemplateVariableNames = [],
}: {
  title: string;
  description: string;
  value: RoutineVariable[];
  onChange: (value: RoutineVariable[]) => void;
  preserveUnmatchedVariables?: boolean;
  allowManualVariables?: boolean;
  manualVariableNamesSeed?: string[];
  heading?: string;
  descriptionText?: string;
  emptyMessage?: string | null;
  addButtonLabel?: string;
  resolvedTemplateVariableNames?: string[];
}) {
  const [open, setOpen] = useState(true);
  const resolvedTemplateVariableSignature = resolvedTemplateVariableNames.join("\n");
  const resolvedTemplateVariableNameSet = useMemo(
    () => new Set(resolvedTemplateVariableNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedTemplateVariableSignature],
  );
  const templateInputsForPrompts = useMemo(
    () => [
      stripResolvedTemplateVariables(title, resolvedTemplateVariableNameSet),
      stripResolvedTemplateVariables(description, resolvedTemplateVariableNameSet),
    ],
    [description, resolvedTemplateVariableNameSet, title],
  );
  const templateNames = useMemo(
    () => new Set(extractRoutineVariableNames(templateInputsForPrompts).filter((name) => !isBuiltinRoutineVariable(name))),
    [templateInputsForPrompts],
  );
  const [manualVariableNames, setManualVariableNames] = useState<Set<string>>(() =>
    preserveUnmatchedVariables ? new Set(manualVariableNamesSeed ?? manualVariableNameSet(value, templateNames)) : new Set(),
  );
  const manualVariableNamesSeedSignature = (manualVariableNamesSeed ?? []).join("\n");
  useEffect(() => {
    if (!preserveUnmatchedVariables || manualVariableNamesSeed === undefined) return;
    setManualVariableNames(new Set(manualVariableNamesSeed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualVariableNamesSeedSignature, preserveUnmatchedVariables]);
  const cleanValue = useMemo(
    () => stripVariablesByName(unmarkVariables(value), resolvedTemplateVariableNameSet),
    [resolvedTemplateVariableNameSet, value],
  );
  const syncedVariables = useMemo(
    () => {
      if (!preserveUnmatchedVariables) {
        return syncRoutineVariablesWithTemplate(templateInputsForPrompts, cleanValue);
      }
      return editableVariables(
        syncVariables(templateInputsForPrompts, cleanValue, manualVariableNames),
        manualVariableNames,
      );
    },
    [cleanValue, manualVariableNames, preserveUnmatchedVariables, templateInputsForPrompts],
  );
  const syncedSignature = serializeVariables(unmarkVariables(syncedVariables));
  const currentSignature = serializeVariables(cleanValue);

  useEffect(() => {
    if (!preserveUnmatchedVariables) return;
    if (value.length === 0 && manualVariableNamesSeed && manualVariableNamesSeed.length > 0) return;
    const existingNames = variableNameSet(cleanValue);
    setManualVariableNames((current) => pruneManualVariableNameSet(current, existingNames));
  }, [cleanValue, manualVariableNamesSeed, preserveUnmatchedVariables]);

  useEffect(() => {
    if (syncedSignature !== currentSignature) {
      onChange(syncedVariables);
    }
  }, [currentSignature, onChange, syncedSignature, syncedVariables]);

  if (syncedVariables.length === 0 && !allowManualVariables) {
    return null;
  }

  const addVariable = () => {
    setOpen(true);
    const variable = defaultManualVariable(syncedVariables);
    setManualVariableNames((current) => addManualVariableName(current, variable.name));
    onChange([...syncedVariables, variable]);
  };

  const removeManualVariable = (name: string) => {
    setManualVariableNames((current) => removeManualVariableName(current, name));
    onChange(removeVariable(syncedVariables, name));
  };

  const renameManualVariable = (name: string, nextName: string) => {
    const normalizedName = nextName.trim();
    if (!isValidRoutineVariableName(normalizedName)) return;
    if (syncedVariables.some((variable) => variable.name !== name && variable.name === normalizedName)) return;
    setManualVariableNames((current) => updateManualVariableNameSet(current, name, normalizedName));
    onChange(updateVariableName(syncedVariables, name, normalizedName));
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border border-border/70">
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <CollapsibleTrigger className="flex min-w-0 flex-1 items-start justify-between gap-3 text-left">
          <div className="min-w-0">
            <p className="text-sm font-medium">{heading}</p>
            <p className="text-xs text-muted-foreground">{descriptionText}</p>
          </div>
          {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        </CollapsibleTrigger>
        {allowManualVariables ? (
          <button
            type="button"
            onClick={addVariable}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            {addButtonLabel}
          </button>
        ) : null}
      </div>
      <CollapsibleContent className="divide-y divide-border/70 border-t border-border/70">
        {syncedVariables.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">{emptyMessage ?? "No variables configured."}</div>
        ) : syncedVariables.map((variable) => {
          const fromTemplate = templateNames.has(variable.name);
          return (
          <div key={variable.name} className="p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {`{{${variable.name}}}`}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {fromTemplate
                    ? "Prompted when this placeholder appears in the instructions."
                    : "Prompt the user for this value when a new item starts here."}
                </span>
              </div>
              {allowManualVariables && !fromTemplate ? (
                <button
                  type="button"
                  onClick={() => removeManualVariable(variable.name)}
                  className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove
                </button>
              ) : null}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {allowManualVariables && !fromTemplate ? (
                <div className="space-y-1.5">
                  <Label className="text-xs">Field key</Label>
                  <Input
                    value={variable.name}
                    onChange={(event) => renameManualVariable(variable.name, event.target.value)}
                    placeholder="customer_name"
                  />
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label className="text-xs">Label</Label>
                <Input
                  value={variable.label ?? ""}
                  onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    label: event.target.value || null,
                  })))}
                  placeholder={variable.name.replaceAll("_", " ")}
                />
              </div>

              <div className={allowManualVariables && !fromTemplate ? "space-y-1.5 md:col-span-2" : "space-y-1.5"}>
                <Label className="text-xs">Type</Label>
                <Select
                  value={variable.type}
                  onValueChange={(type) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    type: type as RoutineVariable["type"],
                    defaultValue: type === "boolean" ? null : current.defaultValue,
                    options: type === "select" ? current.options : [],
                  })))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {variableTypes.map((type) => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs">Default value</Label>
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
                  <Textarea
                    rows={3}
                    value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                  />
                ) : variable.type === "boolean" ? (
                  <Select
                    value={variable.defaultValue === true ? "true" : variable.defaultValue === false ? "false" : "__unset__"}
                    onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: next === "__unset__" ? null : next === "true",
                    })))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unset__">No default</SelectItem>
                      <SelectItem value="true">True</SelectItem>
                      <SelectItem value="false">False</SelectItem>
                    </SelectContent>
                  </Select>
                ) : variable.type === "select" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Options</Label>
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
                      <Label className="text-xs">Default option</Label>
                      <Select
                        value={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                        onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                          ...current,
                          defaultValue: next === "__unset__" ? null : next,
                        })))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="No default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unset__">No default</SelectItem>
                          {variable.options.map((option) => (
                            <SelectItem key={option} value={option}>{option}</SelectItem>
                          ))}
                        </SelectContent>
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
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

type BuiltinVariableDoc = {
  name: string;
  example: string;
  description: string;
};

const BUILTIN_VARIABLE_DOCS: BuiltinVariableDoc[] = [
  {
    name: "date",
    example: "2026-04-28",
    description: "Current date in YYYY-MM-DD format (UTC) at the time the routine runs.",
  },
  {
    name: "timestamp",
    example: "April 28, 2026 at 12:17 PM UTC",
    description: "Human-readable date and time (UTC) at the time the routine runs.",
  },
];

export function RoutineVariablesHint({
  summary = 'Use `{{variable_name}}` placeholders in the instructions to prompt for inputs when the routine runs.',
  title = "Routine variables",
  description = "How to prompt for inputs and which variables Paperclip fills in automatically.",
  customHeading = "Custom variables",
  customDescription = (
    <>
      Type{" "}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
        {"{{variable_name}}"}
      </code>{" "}
      anywhere in the title or instructions. Paperclip detects each placeholder, lists it
      under <span className="font-medium text-foreground">Variables</span>, and prompts
      for a value before each run.
    </>
  ),
}: {
  summary?: string;
  title?: string;
  description?: string;
  customHeading?: string;
  customDescription?: ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <span>{summary}</span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Show variable help"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {customHeading}
              </h3>
              <p className="text-muted-foreground">{customDescription}</p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>Names must start with a letter and may use letters, numbers, and underscores.</li>
                <li>Pick a type (text, textarea, number, boolean, select), default value, and whether it is required.</li>
                <li>The same name reused across the title and instructions is treated as one variable.</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Built-in variables
              </h3>
              <p className="text-muted-foreground">
                These are filled in automatically — no setup needed and they will not appear in the
                Variables list.
              </p>
              <div className="overflow-hidden rounded-lg border border-border/70">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Placeholder</th>
                      <th className="px-3 py-2 font-medium">Example</th>
                      <th className="px-3 py-2 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {BUILTIN_VARIABLE_DOCS.map((entry) => (
                      <tr key={entry.name} className="align-top">
                        <td className="px-3 py-2">
                          <Badge variant="outline" className="font-mono text-xs">{`{{${entry.name}}}`}</Badge>
                        </td>
                        <td className="px-3 py-2 font-mono text-muted-foreground">{entry.example}</td>
                        <td className="px-3 py-2 text-muted-foreground">{entry.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
