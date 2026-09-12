import { t, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, HelpCircle } from "lucide-react";
import { isValidRoutineDateString, syncRoutineVariablesWithTemplate, type RoutineVariable } from "@paperclipai/shared";
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

const variableTypes: RoutineVariable["type"][] = ["text", "textarea", "number", "boolean", "select", "date"];

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

function defaultValueForType(type: RoutineVariable["type"], current: RoutineVariable["defaultValue"]) {
  if (type === "boolean") return null;
  if (type === "date") {
    return typeof current === "string" && isValidRoutineDateString(current) ? current : null;
  }
  return current;
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
          <p className="text-sm font-medium">{t("localizationRoutines.variables")}</p>
          <p className="text-xs text-muted-foreground">
            {t("localizationRoutines.detectedVariables", { placeholder: "{{name}}" })}
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
              <span className="text-xs text-muted-foreground">{t("localizationRoutines.promptValue")}</span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("localizationRoutines.label")}</Label>
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
                <Label className="text-xs">{t("localizationRoutines.type")}</Label>
                <Select
                  value={variable.type}
                  onValueChange={(type) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                    ...current,
                    type: type as RoutineVariable["type"],
                    defaultValue: defaultValueForType(type as RoutineVariable["type"], current.defaultValue),
                    options: type === "select" ? current.options : [],
                  })))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {variableTypes.map((type) => (
                      <SelectItem key={type} value={type}>{t(`localizationRoutines.variableType_${type}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5 md:col-span-2">
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs">{t("localizationRoutines.defaultInput")}</Label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                        ...current,
                        required: event.target.checked,
                      })))}
                    />{t("localizationRoutines.required")}</label>
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
                      <SelectItem value="__unset__">{t("localizationRoutines.noDefault")}</SelectItem>
                      <SelectItem value="true">{t("localizationRoutines.true")}</SelectItem>
                      <SelectItem value="false">{t("localizationRoutines.false")}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : variable.type === "select" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("localizationRoutines.options")}</Label>
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
                        placeholder={t("localizationRoutines.optionsExample")}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("localizationRoutines.defaultOption")}</Label>
                      <Select
                        value={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                        onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                          ...current,
                          defaultValue: next === "__unset__" ? null : next,
                        })))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("localizationRoutines.noDefault")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unset__">{t("localizationRoutines.noDefault")}</SelectItem>
                          {variable.options.map((option) => (
                            <SelectItem key={option} value={option}>{option}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                ) : variable.type === "date" ? (
                  <Input
                    type="date"
                    value={typeof variable.defaultValue === "string" ? variable.defaultValue : ""}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                  />
                ) : (
                  <Input
                    type={variable.type === "number" ? "number" : "text"}
                    value={variable.defaultValue == null ? "" : String(variable.defaultValue)}
                    onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                      ...current,
                      defaultValue: event.target.value || null,
                    })))}
                    placeholder={variable.type === "number" ? "42" : t("localizationRoutines.defaultInput")}
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

const BUILTIN_VARIABLE_DOCS: BuiltinVariableDoc[] = [
  {
    name: "date",
    example: "2026-04-28",
    get description() { return t("localizationRoutines.dateHelp"); },
  },
  {
    name: "timestamp",
    example: "April 28, 2026 at 12:17 PM UTC",
    get description() { return t("localizationRoutines.timestampHelp"); },
  },
];

export function RoutineVariablesHint() {
  const { t } = useTranslation();
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {t("localizationRoutines.variableHint", { placeholder: "{{variable_name}}" })}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("localizationRoutines.showVariableHelp")}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("localizationRoutines.routineVariables")}</DialogTitle>
            <DialogDescription>{t("localizationRoutines.variableHelpSummary")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationRoutines.customVariables")}</h3>
              <p className="text-muted-foreground">
                <Trans
                  i18nKey="localizationRoutines.customVariableHelp"
                  values={{ placeholder: "{{variable_name}}" }}
                  components={{
                    code: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground" />,
                    strong: <span className="font-medium text-foreground" />,
                  }}
                />
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>{t("localizationRoutines.variableNames")}</li>
                <li>{t("localizationRoutines.variableConfiguration")}</li>
                <li>{t("localizationRoutines.variableDateNames")}</li>
                <li>{t("localizationRoutines.variableSameName")}</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationRoutines.builtInVariables")}</h3>
              <p className="text-muted-foreground">{t("localizationRoutines.builtInHelp")}</p>
              <div className="overflow-hidden rounded-lg border border-border/70">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t("localizationRoutines.placeholder")}</th>
                      <th className="px-3 py-2 font-medium">{t("localizationRoutines.example")}</th>
                      <th className="px-3 py-2 font-medium">{t("localizationRoutines.description")}</th>
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
