import { t, useTranslation } from "@/i18n";
import { toolRiskLabel, toolEntityLabel } from "../shared";
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plug, Plus, Search, X } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  appCheckState,
  appSelectionLabel,
  isToolSelected,
  toggleApp,
  toggleTool,
  toolCapability,
  CAPABILITY_LABEL,
  type AdvancedRule,
  type AdvancedRuleKind,
  type AppGroup,
  type ToolCapability,
  type WizardSelections,
} from "./profile-model";
import { LoadingState } from "../shared";

type NewToolsAction = "deny" | "allow";

const CAPABILITY_FILTERS: ToolCapability[] = ["read", "write", "destructive"];

const CAPABILITY_VARIANT: Record<ToolCapability, "outline" | "secondary" | "destructive"> = {
  read: "outline",
  write: "secondary",
  destructive: "destructive",
};

export interface WizardToolsStepProps {
  appGroups: AppGroup[];
  catalogLoading: boolean;
  selections: WizardSelections;
  onSelectionsChange: (next: WizardSelections) => void;
  advancedRules: AdvancedRule[];
  onAdvancedRulesChange: (next: AdvancedRule[]) => void;
  newToolsAction: NewToolsAction;
  onNewToolsActionChange: (next: NewToolsAction) => void;
}

export function WizardToolsStep(props: WizardToolsStepProps) {
  const { t } = useTranslation();
  const { appGroups, catalogLoading, selections, onSelectionsChange } = props;
  const [search, setSearch] = useState("");
  const [capabilityFilter, setCapabilityFilter] = useState<ToolCapability | null>(null);

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return appGroups
      .map((group) => {
        const tools = group.tools.filter((tool) => {
          if (capabilityFilter && toolCapability(tool) !== capabilityFilter) return false;
          if (!q) return true;
          return (
            tool.toolName.toLowerCase().includes(q) ||
            (tool.title ?? "").toLowerCase().includes(q) ||
            group.name.toLowerCase().includes(q)
          );
        });
        return { group, tools };
      })
      .filter((entry) => entry.tools.length > 0);
  }, [appGroups, search, capabilityFilter]);

  if (catalogLoading) return <LoadingState label={t("localizationApps.loadingTools34")} />;

  // Cold state A (AP17): nothing connected at all.
  if (appGroups.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border py-12 text-center">
        <Plug className="h-6 w-6 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium text-foreground">{t("localizationTools.appConnectionsAreComingSoon197")}</p>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">{t("localizationTools.profilesWillBeAvailableOnceAppConnectionsAreR198")}</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/apps">{t("localizationTools.browseAppConnections199")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-(--sz-220px) flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("localizationTools.searchTools200")}
            className="pl-8"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {CAPABILITY_FILTERS.map((cap) => (
            <button
              key={cap}
              type="button"
              onClick={() => setCapabilityFilter((cur) => (cur === cap ? null : cap))}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                capabilityFilter === cap
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-accent",
              )}
            >
              {CAPABILITY_LABEL[cap]}
            </button>
          ))}
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        // Cold state B (AP17): a search/filter that matches nothing.
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
          <p className="text-sm font-medium text-foreground">{t("localizationTools.noToolsMatch", { query: search })}</p>
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setCapabilityFilter(null);
            }}
            className="text-sm font-medium text-primary hover:underline"
          >{t("pages.search.clearSearchAriaLabel")}</button>
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {filteredGroups.map(({ group, tools }) => (
            <AppRow
              key={group.appKey}
              group={group}
              visibleTools={tools}
              selection={selections[group.appKey]}
              onToggleApp={() =>
                onSelectionsChange({ ...selections, [group.appKey]: toggleApp(group, selections[group.appKey]) })
              }
              onToggleTool={(toolId) =>
                onSelectionsChange({
                  ...selections,
                  [group.appKey]: toggleTool(group, selections[group.appKey], toolId),
                })
              }
            />
          ))}
        </div>
      )}

      <NewToolsRadio value={props.newToolsAction} onChange={props.onNewToolsActionChange} />

      <AdvancedRules rules={props.advancedRules} onChange={props.onAdvancedRulesChange} />
    </div>
  );
}

function AppRow({
  group,
  visibleTools,
  selection,
  onToggleApp,
  onToggleTool,
}: {
  group: AppGroup;
  visibleTools: AppGroup["tools"];
  selection: WizardSelections[string] | undefined;
  onToggleApp: () => void;
  onToggleTool: (toolId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const state = appCheckState(group, selection);
  const checked = state === "checked" ? true : state === "indeterminate" ? "indeterminate" : false;

  return (
    <div>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Checkbox checked={checked} onCheckedChange={onToggleApp} aria-label={t("localizationTools.allGroupTools", { name: group.name })} />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-1.5 text-left"
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="flex flex-col">
            <span className="text-sm font-medium text-foreground">{t("localizationTools.allGroupToolsCount", { name: group.name, count: group.tools.length })}
            </span>
            <span className="text-xs text-muted-foreground">
              {state === "indeterminate"
                ? appSelectionLabel(group, selection)
                : t("localizationTools.includesFutureTools", { app: group.name })}
            </span>
          </span>
        </button>
      </div>

      {expanded ? (
        <div className="space-y-0.5 border-t border-border bg-muted/20 px-3 py-2 pl-10">
          {visibleTools.map((tool) => {
            const cap = toolCapability(tool);
            return (
              <label
                key={tool.id}
                className="flex cursor-pointer items-start gap-2.5 rounded-md px-1.5 py-1.5 hover:bg-accent/50"
              >
                <Checkbox
                  className="mt-0.5"
                  checked={isToolSelected(group, selection, tool.id)}
                  onCheckedChange={() => onToggleTool(tool.id)}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <code className="font-mono text-xs text-foreground">{tool.toolName}</code>
                    <Badge variant={CAPABILITY_VARIANT[cap]} className="text-(length:--text-nano)">
                      {CAPABILITY_LABEL[cap]}
                    </Badge>
                  </span>
                  {tool.title || tool.description ? (
                    <span className="text-xs text-muted-foreground">{tool.title ?? tool.description}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function NewToolsRadio({
  value,
  onChange,
}: {
  value: NewToolsAction;
  onChange: (next: NewToolsAction) => void;
}) {
  const { t } = useTranslation();
  const options: Array<{ value: NewToolsAction; label: string; hint: string; recommended?: boolean }> = [
    {
      value: "deny",
      label: t("localizationTools.stayBlockedUntilSomeoneAllowsThem207"),
      hint: t("localizationTools.newToolsAnAppAddsLaterWonTBeUsableUntilYouRev208"),
      recommended: true,
    },
    {
      value: "allow",
      label: t("localizationTools.allowedAutomatically152"),
      hint: t("localizationTools.anyToolAnAppAddsLaterBecomesUsableRightAway209"),
    },
  ];
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-4">
      <legend className="px-1 text-sm font-medium text-foreground">{t("localizationTools.newToolsThatAppearLater121")}</legend>
      <div className="space-y-2">
        {options.map((opt) => (
          <label key={opt.value} className="flex cursor-pointer items-start gap-2.5">
            <input
              type="radio"
              name="new-tools-action"
              className="mt-0.5"
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                {opt.label}
                {opt.recommended ? (
                  <Badge variant="outline" className="text-(length:--text-nano)">{t("pages.apps.connect.access.recommended")}</Badge>
                ) : (
                  <span className="text-xs font-normal text-amber-600">{t("localizationTools.risky210")}</span>
                )}
              </span>
              <span className="text-xs text-muted-foreground">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const RULE_KIND_OPTIONS: Array<{ value: AdvancedRuleKind; label: string }> = [
  { value: "tool_name", get label() { return t("localizationTools.toolNamePattern211"); } },
  { value: "risk_level", get label() { return t("localizationTools.riskLevel212"); } },
  { value: "catalog_entry", get label() { return t("localizationTools.byToolID213"); } },
];

function createAdvancedRuleId() {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  return `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ruleSummary(rule: AdvancedRule): string {
  if (rule.kind === "tool_name") return rule.effect === "include" ? t("localizationTools.allowMatchingTools", { value: rule.value }) : t("localizationTools.blockMatchingTools", { value: rule.value });
  if (rule.kind === "risk_level") return rule.effect === "include" ? t("localizationTools.allowRiskTools", { risk: toolRiskLabel(rule.riskLevel ?? rule.value) }) : t("localizationTools.blockRiskTools", { risk: toolRiskLabel(rule.riskLevel ?? rule.value) });
  return rule.effect === "include" ? t("localizationTools.allowNamedTool", { value: rule.value }) : t("localizationTools.blockNamedTool", { value: rule.value });
}

function AdvancedRules({
  rules,
  onChange,
}: {
  rules: AdvancedRule[];
  onChange: (next: AdvancedRule[]) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AdvancedRuleKind>("tool_name");
  const [value, setValue] = useState("");
  const [effect, setEffect] = useState<"include" | "exclude">("include");

  const addRule = () => {
    const trimmed = value.trim();
    if (!trimmed && kind !== "risk_level") return;
    const rule: AdvancedRule = {
      id: createAdvancedRuleId(),
      kind,
      value: kind === "risk_level" ? (trimmed || "destructive") : trimmed,
      riskLevel: kind === "risk_level" ? ((trimmed || "destructive") as AdvancedRule["riskLevel"]) : undefined,
      effect,
    };
    onChange([...rules, rule]);
    setValue("");
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-left">
        <span className="text-sm font-medium text-foreground">{t("localizationTools.advancedRules221")}</span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t border-border px-4 py-3">
        <p className="text-xs text-muted-foreground">{t("localizationTools.matchToolsByANamePatternARiskLevelOrASpecific222")}</p>

        {rules.length > 0 ? (
          <ul className="space-y-1.5">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5 text-sm"
              >
                <span className="text-foreground">{ruleSummary(rule)}</span>
                <button
                  type="button"
                  aria-label={t("localizationTools.removeRule223")}
                  onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-end gap-2">
          <Select value={effect} onValueChange={(v) => setEffect(v as "include" | "exclude")}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="include">{t("localizationProjects.ui_Allow")}</SelectItem>
              <SelectItem value="exclude">{t("localizationTools.block216")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={(v) => setKind(v as AdvancedRuleKind)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RULE_KIND_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {kind === "risk_level" ? (
            <Select value={value || "destructive"} onValueChange={setValue}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">{t("localizationSkills.readOnly459")}</SelectItem>
                <SelectItem value={"write"}>{t("localizationTools.makesChanges86")}</SelectItem>
                <SelectItem value={"destructive"}>{t("localizationTools.destructive87")}</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={kind === "tool_name" ? t("localizationTools.eGGmailSend224") : t("localizationTools.toolID225")}
              className="w-44"
            />
          )}
          <Button type="button" variant="outline" size="sm" onClick={addRule}>
            <Plus className="mr-1 h-3.5 w-3.5" />{t("localizationTools.addRule226")}</Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
