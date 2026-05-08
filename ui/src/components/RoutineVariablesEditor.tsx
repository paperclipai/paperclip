import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("routines");
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
          <p className="text-sm font-medium">{t("variablesEditor.variables")}</p>
          <p className="text-xs text-muted-foreground">
            {t("variablesEditor.detectedFromPlaceholders")}
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
                {t("variablesEditor.promptUser")}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("variablesEditor.label")}</Label>
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
                <Label className="text-xs">{t("variablesEditor.type")}</Label>
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
                  <Label className="text-xs">{t("variablesEditor.defaultValue")}</Label>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={variable.required}
                      onChange={(event) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                        ...current,
                        required: event.target.checked,
                      })))}
                    />
                    {t("variablesEditor.required")}
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
                      <SelectItem value="__unset__">{t("variablesEditor.noDefault")}</SelectItem>
                      <SelectItem value="true">{t("variablesEditor.true")}</SelectItem>
                      <SelectItem value="false">{t("variablesEditor.false")}</SelectItem>
                    </SelectContent>
                  </Select>
                ) : variable.type === "select" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("variablesEditor.options")}</Label>
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
                        placeholder={t("variablesEditor.optionsPlaceholder")}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs">{t("variablesEditor.defaultOption")}</Label>
                      <Select
                        value={typeof variable.defaultValue === "string" ? variable.defaultValue : "__unset__"}
                        onValueChange={(next) => onChange(updateVariableList(syncedVariables, variable.name, (current) => ({
                          ...current,
                          defaultValue: next === "__unset__" ? null : next,
                        })))}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder={t("variablesEditor.noDefault")} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__unset__">{t("variablesEditor.noDefault")}</SelectItem>
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
                    placeholder={variable.type === "number" ? t("variablesEditor.numberPlaceholder") : t("variablesEditor.textPlaceholder")}
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

function getBuiltinVariableDocs(t: (key: string) => string): BuiltinVariableDoc[] {
  return [
    {
      name: "date",
      example: "2026-04-28",
      description: t("variablesHelp.builtinDateDescription"),
    },
    {
      name: "timestamp",
      example: "April 28, 2026 at 12:17 PM UTC",
      description: t("variablesHelp.builtinTimestampDescription"),
    },
  ];
}

export function RoutineVariablesHint() {
  const { t } = useTranslation("routines");
  const [helpOpen, setHelpOpen] = useState(false);
  const builtinDocs = getBuiltinVariableDocs(t);

  return (
    <>
      <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {t("variablesHelp.hintText")}
        </span>
        <button
          type="button"
          onClick={() => setHelpOpen(true)}
          className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("variablesHelp.ariaLabel")}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("variablesHelp.title")}</DialogTitle>
            <DialogDescription>
              {t("variablesHelp.description")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t("variablesHelp.customVariables")}
              </h3>
              <p className="text-muted-foreground">
                {t("variablesHelp.customVariablesIntro", { placeholder: "{{variable_name}}" })}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>{t("variablesHelp.namingRules")}</li>
                <li>{t("variablesHelp.typeRules")}</li>
                <li>{t("variablesHelp.reuseRules")}</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {t("variablesHelp.builtinVariables")}
              </h3>
              <p className="text-muted-foreground">
                {t("variablesHelp.builtinIntro")}
              </p>
              <div className="overflow-hidden rounded-lg border border-border/70">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{t("variablesHelp.table.placeholder")}</th>
                      <th className="px-3 py-2 font-medium">{t("variablesHelp.table.example")}</th>
                      <th className="px-3 py-2 font-medium">{t("variablesHelp.table.description")}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/70">
                    {builtinDocs.map((entry) => (
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
