import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import { syncRoutineVariablesWithTemplate, type RoutineVariable } from "@paperclipai/shared";
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
import { t, useTranslation } from "@/i18n";

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
  title,
  description,
  value,
  onChange,
}: {
  title: string;
  description: string;
  value: RoutineVariable[];
  onChange: (value: RoutineVariable[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const syncedVariables = useMemo(
    () => syncRoutineVariablesWithTemplate([title, description], value),
    [description, title, value],
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
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-lg border border-border/70">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left">
        <div>
          <p className="text-sm font-medium">{t("components.routineVariablesEditor.variablesHeading", { defaultValue: "Variables" })}</p>
          <p className="text-xs text-muted-foreground">
            {t("components.routineVariablesEditor.variablesDetectedHint", { placeholder: "{{name}}", defaultValue: "Detected from `{{placeholder}}` placeholders in the routine title and instructions." })}
          </p>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y divide-border/70 border-t border-border/70">
        {syncedVariables.map((variable) => (
          <div key={variable.name} className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="font-mono text-xs">
                {`{{${variable.name}}}`}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t("components.routineVariablesEditor.promptForValue", { defaultValue: "Prompt the user for this value before each manual run." })}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("components.routineVariablesEditor.labelLabel", { defaultValue: "Label" })}</Label>
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
                <Label className="text-xs">{t("components.routineVariablesEditor.typeLabel", { defaultValue: "Type" })}</Label>
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
                  <Label className="text-xs">{t("components.routineVariablesEditor.defaultValueLabel", { defaultValue: "Default value" })}</Label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                        ...current,
                        required: event.target.checked,
                      })))}
                    />
                    {t("components.routineVariablesEditor.requiredLabel", { defaultValue: "Required" })}
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
                      <SelectItem value="__unset__">{t("components.routineVariablesEditor.noDefault", { defaultValue: "No default" })}</SelectItem>
                      <SelectItem value="true">{t("components.routineVariablesEditor.booleanTrue", { defaultValue: "True" })}</SelectItem>
                      <SelectItem value="false">{t("components.routineVariablesEditor.booleanFalse", { defaultValue: "False" })}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : variable.type === "select" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("components.routineVariablesEditor.optionsLabel", { defaultValue: "Options" })}</Label>
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
                        placeholder={t("components.routineVariablesEditor.optionsPlaceholder", { defaultValue: "high, medium, low" })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("components.routineVariablesEditor.defaultOptionLabel", { defaultValue: "Default option" })}</Label>
                      <Select
                        value={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                        onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                          ...current,
                          defaultValue: next === "__unset__" ? null : next,
                        })))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("components.routineVariablesEditor.noDefault", { defaultValue: "No default" })} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unset__">{t("components.routineVariablesEditor.noDefault", { defaultValue: "No default" })}</SelectItem>
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
                    placeholder={variable.type === "number" ? "42" : t("components.routineVariablesEditor.defaultValuePlaceholder", { defaultValue: "Default value" })}
                  />
                )}
              </div>
            </div>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

type BuiltinVariableDoc = {
  name: string;
  example: string;
  description: string;
};

function getBuiltinVariableDocs(): BuiltinVariableDoc[] {
  return [
    {
      name: "date",
      example: "2026-04-28",
      description: t("components.routineVariablesEditor.builtinDateDescription", {
        defaultValue: "Current date in YYYY-MM-DD format (UTC) at the time the routine runs.",
      }),
    },
    {
      name: "timestamp",
      example: t("components.routineVariablesEditor.builtinTimestampExample", {
        defaultValue: "April 28, 2026 at 12:17 PM UTC",
      }),
      description: t("components.routineVariablesEditor.builtinTimestampDescription", {
        defaultValue: "Human-readable date and time (UTC) at the time the routine runs.",
      }),
    },
  ];
}

export function RoutineVariablesHint() {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);
  const builtinVariableDocs = getBuiltinVariableDocs();

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {t("components.routineVariablesEditor.hintUsePlaceholders", { placeholder: "{{variable_name}}", defaultValue: "Use `{{placeholder}}` placeholders in the instructions to prompt for inputs when the routine runs." })}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("components.routineVariablesEditor.showVariableHelp", { defaultValue: "Show variable help" })}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("components.routineVariablesEditor.dialogTitle", { defaultValue: "Routine variables" })}</DialogTitle>
            <DialogDescription>
              {t("components.routineVariablesEditor.dialogDescription", { defaultValue: "How to prompt for inputs and which variables Paperclip fills in automatically." })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t("components.routineVariablesEditor.customVariablesHeading", { defaultValue: "Custom variables" })}
              </h3>
              <p className="text-muted-foreground">
                {t("components.routineVariablesEditor.customVariablesTypePrefix", { defaultValue: "Type" })}{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">
                  {"{{variable_name}}"}
                </code>{" "}
                {t("components.routineVariablesEditor.customVariablesAnywhere", { defaultValue: "anywhere in the title or instructions. Paperclip detects each placeholder, lists it under" })}{" "}
                <span className="font-medium text-foreground">{t("components.routineVariablesEditor.variablesHeading", { defaultValue: "Variables" })}</span>
                {t("components.routineVariablesEditor.customVariablesPromptsSuffix", { defaultValue: ", and prompts for a value before each run." })}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>{t("components.routineVariablesEditor.customVariablesRuleNames", { defaultValue: "Names must start with a letter and may use letters, numbers, and underscores." })}</li>
                <li>{t("components.routineVariablesEditor.customVariablesRuleType", { defaultValue: "Pick a type (text, textarea, number, boolean, select), default value, and whether it is required." })}</li>
                <li>{t("components.routineVariablesEditor.customVariablesRuleReuse", { defaultValue: "The same name reused across the title and instructions is treated as one variable." })}</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t("components.routineVariablesEditor.builtinVariablesHeading", { defaultValue: "Built-in variables" })}
              </h3>
              <p className="text-muted-foreground">
                {t("components.routineVariablesEditor.builtinVariablesDescription", { defaultValue: "These are filled in automatically — no setup needed and they will not appear in the Variables list." })}
              </p>
              <div className="overflow-hidden rounded-lg border border-border/70">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t("components.routineVariablesEditor.columnPlaceholder", { defaultValue: "Placeholder" })}</th>
                      <th className="px-3 py-2 font-medium">{t("components.routineVariablesEditor.columnExample", { defaultValue: "Example" })}</th>
                      <th className="px-3 py-2 font-medium">{t("components.routineVariablesEditor.columnDescription", { defaultValue: "Description" })}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {builtinVariableDocs.map((entry) => (
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
