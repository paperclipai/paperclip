import { t, useTranslation } from "@/i18n";
import { useCallback, useMemo, useState } from "react";
import {
  analyzeFrontmatterBlock,
  asStringArray,
  getSkillFrontmatterUnknownKeys,
  isFrontmatterPlainRecord,
  parseFrontmatterFields,
  stringifyFrontmatter,
} from "@paperclipai/shared";
import { AlertTriangle, ChevronDown, ChevronRight, Info, Plus, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Skill Studio frontmatter editor (PAP-13145 Option B / PAP-13155).
 *
 * The rich markdown editor must never see the leading `---` YAML block or it
 * corrupts it into headings/thematic breaks on every round-trip. Studio splits
 * the file into a frontmatter block (owned by this panel) and a body (owned by
 * MarkdownEditor); this panel offers a schema-aware Fields form when the YAML
 * can be safely re-serialized, and always falls back to raw YAML when it can't.
 *
 * Byte-identity guarantee (QA PAP-13156): this panel only calls `onChange` in
 * response to a real user edit. Opening a file and saving it untouched never
 * routes through the serializer, so bytes are preserved exactly. Callers must
 * mount this panel with a per-file `key` so its local state resets on file
 * switches.
 */

type FrontmatterMode = "fields" | "yaml";

export interface FrontmatterPanelChange {
  frontmatterText: string;
  hasFrontmatter: boolean;
}

export interface FrontmatterPanelProps {
  /** Raw YAML block between the `---` fences (from `splitFrontmatterBlock`). */
  frontmatterText: string;
  hasFrontmatter: boolean;
  /** File path, e.g. `SKILL.md`. Drives required-field rules + expand default. */
  fileName: string;
  /** Skill slug used to seed `name:` when adding frontmatter to a SKILL.md. */
  skillSlug?: string;
  readOnly?: boolean;
  onChange: (change: FrontmatterPanelChange) => void;
  className?: string;
}

type ScalarValue = string | number | boolean | null;

interface ScalarRow {
  id: string;
  key: string;
  /** Original parsed value, preserved verbatim until the row is edited. */
  rawValue: unknown;
  text: string;
  edited: boolean;
}

interface UnknownRow extends ScalarRow {
  editable: boolean;
}

interface FormModel {
  hasName: boolean;
  name: string;
  hasDescription: boolean;
  description: string;
  allowedToolsPresent: boolean;
  /** null → present but not a string list (type mismatch, edit in YAML). */
  allowedTools: string[] | null;
  metadataPresent: boolean;
  /** null → metadata is a plain scalar record we can edit as rows. */
  metadataComplex: unknown;
  metaRows: ScalarRow[];
  unknown: UnknownRow[];
}

function isScalar(value: unknown): value is ScalarValue {
  return (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  );
}

function scalarToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** Coerce edited text back to a YAML scalar so `version: 2` stays a number. */
function coerceScalar(text: string): ScalarValue {
  if (text === "") return "";
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(\.\d+)?$/u.test(text)) return Number(text);
  return text;
}

function isFlatScalarRecord(value: unknown): value is Record<string, ScalarValue> {
  return isFrontmatterPlainRecord(value) && Object.values(value).every(isScalar);
}

function buildFormModel(obj: Record<string, unknown>): FormModel {
  const allowedToolsPresent = "allowed-tools" in obj;
  const metadataValue = obj.metadata;
  const metadataPresent = "metadata" in obj;
  const metadataEditable = metadataPresent && isFlatScalarRecord(metadataValue);

  const metaRows: ScalarRow[] = metadataEditable
    ? Object.entries(metadataValue as Record<string, ScalarValue>).map(([key, value], index) => ({
        id: `meta-${index}-${key}`,
        key,
        rawValue: value,
        text: scalarToText(value),
        edited: false,
      }))
    : [];

  const unknown: UnknownRow[] = getSkillFrontmatterUnknownKeys(obj).map((key, index) => {
    const value = obj[key];
    const editable = isScalar(value);
    return {
      id: `unknown-${index}-${key}`,
      key,
      rawValue: value,
      text: scalarToText(value),
      edited: false,
      editable,
    };
  });

  return {
    hasName: "name" in obj,
    name: typeof obj.name === "string" ? obj.name : scalarToText(obj.name),
    hasDescription: "description" in obj,
    description: typeof obj.description === "string" ? obj.description : scalarToText(obj.description),
    allowedToolsPresent,
    allowedTools: allowedToolsPresent ? asStringArray(obj["allowed-tools"]) : [],
    metadataPresent,
    metadataComplex: metadataPresent && !metadataEditable ? metadataValue : null,
    metaRows,
    unknown,
  };
}

function scalarRowsToObject(rows: ScalarRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.edited ? coerceScalar(row.text) : row.rawValue;
  }
  return out;
}

/**
 * Rebuild the frontmatter object from the form. Known keys are emitted in schema
 * order (name, description, allowed-tools, metadata) followed by unknown keys —
 * matches the panel's display order. Only reached in Fields mode, which is only
 * available for round-trippable blocks, so this never runs on messy YAML.
 */
function serializeForm(form: FormModel): string {
  const out: Record<string, unknown> = {};
  if (form.hasName) out.name = form.name;
  if (form.hasDescription) out.description = form.description;
  if (form.allowedToolsPresent) out["allowed-tools"] = form.allowedTools ?? [];
  if (form.metadataPresent) {
    out.metadata = form.metadataComplex !== null ? form.metadataComplex : scalarRowsToObject(form.metaRows);
  }
  for (const row of form.unknown) {
    const key = row.key.trim();
    if (!key) continue;
    out[key] = row.editable && row.edited ? coerceScalar(row.text) : row.rawValue;
  }
  return stringifyFrontmatter(out);
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface ValidationIssue {
  field: string;
  message: string;
}

function collectValidation(form: FormModel, isSkillFile: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const name = form.name.trim();
  const description = form.description.trim();
  if (isSkillFile && !name) issues.push({ field: "name", message: t("task-components:skillMdNeedsAName_a7328230") });
  if (name && !SLUG_RE.test(name)) {
    issues.push({ field: "name", message: t("task-components:useLowercaseLettersNumbersAndHyphens_b42ce9e4") });
  }
  if (isSkillFile && !description) {
    issues.push({ field: "description", message: t("task-components:skillMdNeedsADescription_2b9040c7") });
  }
  if (form.allowedToolsPresent && form.allowedTools === null) {
    issues.push({ field: "allowed-tools", message: t("task-components:expectedAListEditInYaml_9a18330d") });
  }
  return issues;
}

function isSkillMarkdown(fileName: string): boolean {
  return /(^|\/)skill\.md$/i.test(fileName);
}

export function FrontmatterPanel({
  frontmatterText,
  hasFrontmatter,
  fileName,
  skillSlug,
  readOnly = false,
  onChange,
  className,
}: FrontmatterPanelProps) {
  useTranslation("task-components");
  const isSkillFile = isSkillMarkdown(fileName);

  // `yamlText` is the canonical raw block — always equal to whatever we've last
  // emitted (or the original text before any edit). `form` is authoritative only
  // while in Fields mode. Both initialize from props; the caller keys us per file.
  const [present, setPresent] = useState(hasFrontmatter);
  const [yamlText, setYamlText] = useState(frontmatterText);
  const initialAnalysis = useMemo(() => analyzeFrontmatterBlock(frontmatterText), [frontmatterText]);
  const [form, setForm] = useState<FormModel>(() => buildFormModel(initialAnalysis.parsed));
  const [mode, setMode] = useState<FrontmatterMode>(
    hasFrontmatter && initialAnalysis.canRoundTrip ? "fields" : "yaml",
  );
  const [open, setOpen] = useState(false);

  const analysis = useMemo(() => analyzeFrontmatterBlock(yamlText), [yamlText]);
  const canUseFields = present && analysis.canRoundTrip;
  const effectiveMode: FrontmatterMode = mode === "fields" && !canUseFields ? "yaml" : mode;

  const validation = useMemo(
    () => (effectiveMode === "fields" ? collectValidation(form, isSkillFile) : []),
    [effectiveMode, form, isSkillFile],
  );

  const emit = useCallback(
    (nextRaw: string, nextPresent: boolean) => {
      onChange({ frontmatterText: nextRaw, hasFrontmatter: nextPresent });
    },
    [onChange],
  );

  const commitForm = useCallback(
    (nextForm: FormModel) => {
      setForm(nextForm);
      let nextRaw: string;
      try {
        nextRaw = serializeForm(nextForm);
      } catch {
        // Unsupported key/value (e.g. a metadata key with a colon) — drop this
        // edit rather than emit corrupt YAML.
        return;
      }
      setYamlText(nextRaw);
      emit(nextRaw, true);
    },
    [emit],
  );

  const handleYamlChange = useCallback(
    (next: string) => {
      setYamlText(next);
      emit(next, true);
    },
    [emit],
  );

  const switchMode = useCallback(
    (next: FrontmatterMode) => {
      if (next === "fields") {
        if (!canUseFields) return;
        setForm(buildFormModel(parseFrontmatterFields(yamlText)));
      }
      setMode(next);
    },
    [canUseFields, yamlText],
  );

  const addFrontmatter = useCallback(() => {
    const seed: FormModel = {
      hasName: true,
      name: isSkillFile ? (skillSlug ?? "").trim() : "",
      hasDescription: isSkillFile,
      description: "",
      allowedToolsPresent: false,
      allowedTools: [],
      metadataPresent: false,
      metadataComplex: null,
      metaRows: [],
      unknown: [],
    };
    setPresent(true);
    setMode("fields");
    setOpen(true);
    setForm(seed);
    const nextRaw = serializeForm(seed);
    setYamlText(nextRaw);
    emit(nextRaw, true);
  }, [emit, isSkillFile, skillSlug]);

  const summary = useMemo(() => buildSummary(analysis.parsed), [analysis.parsed]);
  const warningCount = validation.length;

  const chevron = open ? (
    <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  ) : (
    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  );

  return (
    <TooltipProvider>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className={cn("border-b border-border", className)}
        data-testid="frontmatter-panel"
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            aria-expanded={open}
            aria-controls="frontmatter-panel-body"
          >
            {chevron}
            <span className="text-sm font-medium">{t("task-components:frontmatter_323d638f")}</span>
            {!open && present ? (
              <span className="truncate text-xs text-muted-foreground">{summary}</span>
            ) : null}
            {!open && !present ? (
              <span className="text-xs text-muted-foreground">{t("task-components:none_dc937b59")}</span>
            ) : null}
          </button>

          {present ? (
            <Tabs
              value={effectiveMode}
              onValueChange={(value) => switchMode(value as FrontmatterMode)}
            >
              <TabsList variant="line" className="h-7">
                {canUseFields ? (
                  <TabsTrigger value="fields" className="px-2 py-0.5 text-xs">{t("task-components:fields_616f48c1")}</TabsTrigger>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>
                        <TabsTrigger
                          value="fields"
                          disabled
                          aria-disabled="true"
                          className="px-2 py-0.5 text-xs opacity-50"
                        >{t("task-components:fields_616f48c1")}</TabsTrigger>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-60">{t("task-components:switchToYamlToEditThisFrontmatter_6a7af0aa")}</TooltipContent>
                  </Tooltip>
                )}
                <TabsTrigger value="yaml" className="px-2 py-0.5 text-xs">
                  YAML
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : !readOnly ? (
            <Button variant="ghost" size="sm" onClick={addFrontmatter} data-testid="add-frontmatter">
              <Plus className="mr-1 h-3.5 w-3.5" />{t("task-components:addFrontmatter_d3629db0")}</Button>
          ) : null}

          {present && effectiveMode === "fields" && warningCount > 0 ? (
            <Badge variant="outline" className="gap-1 text-amber-500" data-testid="frontmatter-warning-chip">
              <AlertTriangle className="h-3.5 w-3.5" />
              {warningCount} {warningCount === 1 ? t("task-components:issue_4a502846") : t("task-components:issues_02e3fe5a")}
            </Badge>
          ) : null}
        </div>

        <CollapsibleContent id="frontmatter-panel-body">
          {present ? (
            <div className="px-3 pb-3">
              {effectiveMode === "fields" ? (
                <FieldsForm
                  form={form}
                  validation={validation}
                  readOnly={readOnly}
                  onCommit={commitForm}
                />
              ) : (
                <YamlEditor
                  value={yamlText}
                  readOnly={readOnly}
                  canReturnToFields={canUseFields}
                  parseError={present && !analysis.canRoundTrip && analysis.issues.length === 0}
                  onChange={handleYamlChange}
                />
              )}
            </div>
          ) : (
            <div className="px-3 pb-2 text-xs text-muted-foreground">{t("task-components:thisFileHasNoFrontmatter_e9f9a856")}</div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </TooltipProvider>
  );
}

function buildSummary(parsed: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof parsed.name === "string" && parsed.name.trim()) parts.push(parsed.name.trim());
  const tools = asStringArray(parsed["allowed-tools"]);
  if (tools && tools.length > 0) parts.push(`${tools.length} ${tools.length === 1 ? "tool" : "tools"}`);
  if (isFrontmatterPlainRecord(parsed.metadata)) {
    const count = Object.keys(parsed.metadata).length;
    if (count > 0) parts.push(`${count} metadata`);
  }
  return parts.join(" · ");
}

function fieldWarning(validation: ValidationIssue[], field: string): string | null {
  return validation.find((issue) => issue.field === field)?.message ?? null;
}

function FieldWarning({ message }: { message: string }) {
  useTranslation("task-components");
  return (
    <p className="mt-1 flex items-center gap-1 text-xs text-amber-500">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {message}
    </p>
  );
}

function FieldsForm({
  form,
  validation,
  readOnly,
  onCommit,
}: {
  form: FormModel;
  validation: ValidationIssue[];
  readOnly: boolean;
  onCommit: (form: FormModel) => void;
}) {
  useTranslation("task-components");
  const nameWarning = fieldWarning(validation, "name");
  const descriptionWarning = fieldWarning(validation, "description");
  const toolsWarning = fieldWarning(validation, "allowed-tools");

  return (
    <div className="space-y-3 pt-1">
      {form.hasName ? (
        <div>
          <Label htmlFor="fm-name" className="text-xs text-muted-foreground">{t("task-components:name_82a3537f")}</Label>
          <Input
            id="fm-name"
            value={form.name}
            readOnly={readOnly}
            aria-invalid={Boolean(nameWarning)}
            onChange={(event) => onCommit({ ...form, name: event.target.value })}
            className="mt-1"
          />
          {nameWarning ? <FieldWarning message={nameWarning} /> : null}
        </div>
      ) : null}

      {form.hasDescription ? (
        <div>
          <Label htmlFor="fm-description" className="text-xs text-muted-foreground">{t("task-components:description_c9046f7a")}</Label>
          <Textarea
            id="fm-description"
            value={form.description}
            readOnly={readOnly}
            rows={3}
            onChange={(event) => onCommit({ ...form, description: event.target.value })}
            className="mt-1"
          />
          {descriptionWarning ? <FieldWarning message={descriptionWarning} /> : null}
        </div>
      ) : null}

      {form.allowedToolsPresent ? (
        <div>
          <Label className="text-xs text-muted-foreground">allowed-tools</Label>
          {form.allowedTools === null ? (
            <p className="mt-1 text-xs text-amber-500">
              {toolsWarning ?? t("task-components:expectedAListEditInYaml_9a18330d")}
            </p>
          ) : (
            <ChipInput
              values={form.allowedTools}
              readOnly={readOnly}
              placeholder={t("task-components:addATool_b048875c")}
              onChange={(next) => onCommit({ ...form, allowedTools: next })}
            />
          )}
        </div>
      ) : null}

      {form.metadataPresent ? (
        <div>
          <Label className="text-xs text-muted-foreground">{t("task-components:metadata_45447b7a")}</Label>
          {form.metadataComplex !== null ? (
            <p className="mt-1 text-xs text-muted-foreground">{t("task-components:complexValueEditInYaml_122b742a")}</p>
          ) : (
            <MetadataRows
              rows={form.metaRows}
              readOnly={readOnly}
              onChange={(rows) => onCommit({ ...form, metaRows: rows })}
            />
          )}
        </div>
      ) : null}

      {form.unknown.map((row, index) =>
        row.editable ? (
          <div key={row.id}>
            <Label htmlFor={`fm-unknown-${row.id}`} className="text-xs text-muted-foreground">
              {row.key}
            </Label>
            <Input
              id={`fm-unknown-${row.id}`}
              value={row.text}
              readOnly={readOnly}
              onChange={(event) => {
                const unknown = form.unknown.slice();
                unknown[index] = { ...row, text: event.target.value, edited: true };
                onCommit({ ...form, unknown });
              }}
              className="mt-1"
            />
          </div>
        ) : (
          <div key={row.id}>
            <Label className="text-xs text-muted-foreground">{row.key}</Label>
            <p className="mt-1 text-xs text-muted-foreground">{t("task-components:complexValueEditInYaml_122b742a")}</p>
          </div>
        ),
      )}
    </div>
  );
}

function MetadataRows({
  rows,
  readOnly,
  onChange,
}: {
  rows: ScalarRow[];
  readOnly: boolean;
  onChange: (rows: ScalarRow[]) => void;
}) {
  useTranslation("task-components");
  const update = (index: number, patch: Partial<ScalarRow>) => {
    const next = rows.slice();
    next[index] = { ...next[index]!, ...patch, edited: true };
    onChange(next);
  };
  const remove = (index: number) => {
    onChange(rows.filter((_, i) => i !== index));
  };
  const add = () => {
    onChange([
      ...rows,
      { id: `meta-new-${rows.length}-${Date.now()}`, key: "", rawValue: "", text: "", edited: true },
    ]);
  };

  return (
    <div className="mt-1 space-y-1.5">
      {rows.map((row, index) => (
        <div key={row.id} className="flex items-center gap-1.5">
          <Input
            aria-label={t("task-components:metadataKey_62df6a6d", { value1: index + 1 })}
            value={row.key}
            readOnly={readOnly}
            placeholder={t("task-components:key_2c70e12b")}
            onChange={(event) => update(index, { key: event.target.value })}
            className="h-8 flex-1 font-mono text-xs"
          />
          <Input
            aria-label={t("task-components:valueFor_3c97e189", { value1: row.key || `field ${index + 1}` })}
            value={row.text}
            readOnly={readOnly}
            placeholder={t("task-components:value_cd42404d")}
            onChange={(event) => update(index, { text: event.target.value })}
            className="h-8 flex-1 text-xs"
          />
          {!readOnly ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              aria-label={t("task-components:remove_d2f6b9b7", { value1: row.key || `field ${index + 1}` })}
              onClick={() => remove(index)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
      {!readOnly ? (
        <Button variant="ghost" size="sm" onClick={add} className="text-xs">
          <Plus className="mr-1 h-3.5 w-3.5" />{t("task-components:addField_2af202cc")}</Button>
      ) : null}
    </div>
  );
}

function ChipInput({
  values,
  readOnly,
  placeholder,
  onChange,
}: {
  values: string[];
  readOnly: boolean;
  placeholder?: string;
  onChange: (values: string[]) => void;
}) {
  useTranslation("task-components");
  const [draft, setDraft] = useState("");

  const commit = () => {
    const value = draft.trim();
    if (!value) return;
    onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-border px-2 py-1.5">
      {values.map((value, index) => (
        <Badge key={`${value}-${index}`} variant="secondary" className="gap-1">
          {value}
          {!readOnly ? (
            <button
              type="button"
              aria-label={t("task-components:remove_d2f6b9b7", { value1: value })}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
              className="hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          ) : null}
        </Badge>
      ))}
      {!readOnly ? (
        <input
          value={draft}
          placeholder={values.length === 0 ? placeholder : undefined}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              commit();
            } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          aria-label={t("task-components:addTool_3076805f")}
          className="min-w-24 flex-1 bg-transparent text-xs outline-none"
        />
      ) : null}
    </div>
  );
}

function YamlEditor({
  value,
  readOnly,
  canReturnToFields,
  parseError,
  onChange,
}: {
  value: string;
  readOnly: boolean;
  canReturnToFields: boolean;
  parseError: boolean;
  onChange: (value: string) => void;
}) {
  useTranslation("task-components");
  return (
    <div className="pt-1">
      {!canReturnToFields && !parseError ? (
        <div className="mb-1.5 flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{t("task-components:editingRawYamlToPreserveFormattingThe_995aee50")}</span>
        </div>
      ) : null}
      <Textarea
        value={value}
        readOnly={readOnly}
        spellCheck={false}
        rows={Math.min(12, Math.max(3, value.split("\n").length))}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono text-xs"
        aria-label={t("task-components:frontmatterYaml_ed16c742")}
      />
      <p className="mt-1 text-xs text-muted-foreground">{t("task-components:rawYamlIsTheSourceOfTruth_2b3b3fb2")}</p>
    </div>
  );
}
