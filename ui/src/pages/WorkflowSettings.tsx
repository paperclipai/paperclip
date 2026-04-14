import { useEffect, useState, useCallback } from "react";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Pencil,
  Plus,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";

/* ------------------------------------------------------------------ */
/*  Types & storage                                                    */
/* ------------------------------------------------------------------ */

interface CustomStatus {
  id: string;
  label: string;
  category: "open" | "closed";
  color: string;
  isDefault: boolean;
}

interface CustomField {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select";
  selectOptions?: string[];
  required: boolean;
}

const STATUS_STORAGE_KEY = "ironworks.custom-statuses";
const FIELDS_STORAGE_KEY = "ironworks.custom-fields";

const DEFAULT_STATUSES: CustomStatus[] = [
  { id: "backlog", label: "Backlog", category: "open", color: "bg-muted-foreground", isDefault: true },
  { id: "todo", label: "Todo", category: "open", color: "bg-blue-500", isDefault: true },
  { id: "in_progress", label: "In Progress", category: "open", color: "bg-yellow-500", isDefault: true },
  { id: "in_review", label: "In Review", category: "open", color: "bg-violet-500", isDefault: true },
  { id: "done", label: "Done", category: "closed", color: "bg-green-500", isDefault: true },
  { id: "cancelled", label: "Cancelled", category: "closed", color: "bg-neutral-500", isDefault: true },
];

const COLOR_OPTIONS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-yellow-500",
  "bg-orange-500",
  "bg-red-500",
  "bg-violet-500",
  "bg-pink-500",
  "bg-cyan-500",
  "bg-emerald-500",
  "bg-muted-foreground",
  "bg-neutral-500",
];

const FIELD_TYPES = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "select", label: "Select" },
] as const;

function loadStatuses(): CustomStatus[] {
  try {
    const raw = localStorage.getItem(STATUS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CustomStatus[];
  } catch { /* ignore */ }
  return [...DEFAULT_STATUSES];
}

function saveStatuses(statuses: CustomStatus[]) {
  localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(statuses));
}

function loadFields(): CustomField[] {
  try {
    const raw = localStorage.getItem(FIELDS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as CustomField[];
  } catch { /* ignore */ }
  return [];
}

function saveFields(fields: CustomField[]) {
  localStorage.setItem(FIELDS_STORAGE_KEY, JSON.stringify(fields));
}

function generateId() {
  return `custom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatusRow({
  status,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
}: {
  status: CustomStatus;
  onUpdate: (updated: CustomStatus) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(status.label);

  function handleSave() {
    if (label.trim()) {
      onUpdate({ ...status, label: label.trim() });
    }
    setEditing(false);
  }

  return (
    <div className="flex items-center gap-2 py-2 px-2 rounded-md hover:bg-accent/30 group">
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
      <div className={cn("h-3 w-3 rounded-full shrink-0", status.color)} />

      {editing ? (
        <div className="flex items-center gap-1 flex-1">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setEditing(false); }}
            className="h-7 text-xs flex-1"
            autoFocus
          />
          <Button variant="ghost" size="icon-xs" onClick={handleSave}>
            <Check className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon-xs" onClick={() => setEditing(false)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ) : (
        <span className="text-sm flex-1">{status.label}</span>
      )}

      <span className={cn(
        "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
        status.category === "open"
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
          : "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
      )}>
        {status.category}
      </span>

      {/* Color picker */}
      <select
        value={status.color}
        onChange={(e) => onUpdate({ ...status, color: e.target.value })}
        className="h-6 text-[10px] bg-muted border border-border rounded px-1"
      >
        {COLOR_OPTIONS.map((c) => (
          <option key={c} value={c}>{c.replace("bg-", "").replace("-500", "")}</option>
        ))}
      </select>

      {/* Category toggle */}
      <button
        className="text-[10px] text-muted-foreground hover:text-foreground"
        onClick={() => onUpdate({ ...status, category: status.category === "open" ? "closed" : "open" })}
      >
        toggle
      </button>

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {!editing && (
          <Button variant="ghost" size="icon-xs" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3" />
          </Button>
        )}
        <Button variant="ghost" size="icon-xs" onClick={onMoveUp} disabled={isFirst}>
          <ArrowUp className="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={onMoveDown} disabled={isLast}>
          <ArrowDown className="h-3 w-3" />
        </Button>
        {!status.isDefault && (
          <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={onDelete}>
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function CustomFieldRow({
  field,
  onUpdate,
  onDelete,
}: {
  field: CustomField;
  onUpdate: (updated: CustomField) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(field.name);
  const [selectOptionsText, setSelectOptionsText] = useState((field.selectOptions ?? []).join(", "));

  function handleSave() {
    if (name.trim()) {
      const updated: CustomField = {
        ...field,
        name: name.trim(),
        selectOptions: field.type === "select"
          ? selectOptionsText.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
      };
      onUpdate(updated);
    }
    setEditing(false);
  }

  return (
    <div className="flex items-center gap-2 py-2 px-2 rounded-md hover:bg-accent/30 group">
      <span className="text-sm flex-1">{field.name}</span>
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
        {field.type}
      </span>
      {field.required && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300 font-medium">
          required
        </span>
      )}
      {field.type === "select" && field.selectOptions && (
        <span className="text-[10px] text-muted-foreground">
          {field.selectOptions.length} options
        </span>
      )}

      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {editing ? (
          <>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              className="h-7 text-xs w-24"
              autoFocus
            />
            {field.type === "select" && (
              <Input
                value={selectOptionsText}
                onChange={(e) => setSelectOptionsText(e.target.value)}
                placeholder="opt1, opt2, opt3"
                className="h-7 text-xs w-32"
              />
            )}
            <Button variant="ghost" size="icon-xs" onClick={handleSave}>
              <Check className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon-xs" onClick={() => setEditing(false)}>
              <X className="h-3 w-3" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="icon-xs" onClick={() => setEditing(true)}>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => onUpdate({ ...field, required: !field.required })}
              title={field.required ? "Make optional" : "Make required"}
            >
              {field.required ? <Check className="h-3 w-3 text-green-500" /> : <X className="h-3 w-3 text-muted-foreground" />}
            </Button>
            <Button variant="ghost" size="icon-xs" className="text-destructive" onClick={onDelete}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export function WorkflowSettings() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [statuses, setStatuses] = useState<CustomStatus[]>(() => loadStatuses());
  const [fields, setFields] = useState<CustomField[]>(() => loadFields());

  // New status form
  const [newStatusLabel, setNewStatusLabel] = useState("");
  const [newStatusCategory, setNewStatusCategory] = useState<"open" | "closed">("open");
  const [showNewStatus, setShowNewStatus] = useState(false);

  // New field form
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState<CustomField["type"]>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [showNewField, setShowNewField] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflow Settings" }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const persistStatuses = useCallback((next: CustomStatus[]) => {
    setStatuses(next);
    saveStatuses(next);
  }, []);

  const persistFields = useCallback((next: CustomField[]) => {
    setFields(next);
    saveFields(next);
  }, []);

  function addStatus() {
    if (!newStatusLabel.trim()) return;
    const next: CustomStatus[] = [
      ...statuses,
      {
        id: generateId(),
        label: newStatusLabel.trim(),
        category: newStatusCategory,
        color: COLOR_OPTIONS[Math.floor(Math.random() * COLOR_OPTIONS.length)],
        isDefault: false,
      },
    ];
    persistStatuses(next);
    setNewStatusLabel("");
    setShowNewStatus(false);
    pushToast({ title: "Status added", tone: "success" });
  }

  function addField() {
    if (!newFieldName.trim()) return;
    const next: CustomField[] = [
      ...fields,
      {
        id: generateId(),
        name: newFieldName.trim(),
        type: newFieldType,
        selectOptions: newFieldType === "select"
          ? newFieldOptions.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined,
        required: false,
      },
    ];
    persistFields(next);
    setNewFieldName("");
    setNewFieldType("text");
    setNewFieldOptions("");
    setShowNewField(false);
    pushToast({ title: "Custom field added", tone: "success" });
  }

  function moveStatus(idx: number, direction: -1 | 1) {
    const next = [...statuses];
    const target = idx + direction;
    if (target < 0 || target >= next.length) return;
    [next[idx], next[target]] = [next[target], next[idx]];
    persistStatuses(next);
  }

  const openCount = statuses.filter((s) => s.category === "open").length;
  const closedCount = statuses.filter((s) => s.category === "closed").length;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Workflow Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Customize issue statuses and add custom fields to your workflow.
        </p>
      </div>

      {/* Custom statuses */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Mission Statuses</h2>
            <span className="text-[10px] text-muted-foreground">
              {openCount} open, {closedCount} closed
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowNewStatus(true)}>
            <Plus className="h-3 w-3 mr-1" />
            Add Status
          </Button>
        </div>

        <div className="space-y-0">
          {statuses.map((status, idx) => (
            <StatusRow
              key={status.id}
              status={status}
              onUpdate={(updated) => {
                const next = statuses.map((s) => s.id === updated.id ? updated : s);
                persistStatuses(next);
              }}
              onDelete={() => {
                persistStatuses(statuses.filter((s) => s.id !== status.id));
                pushToast({ title: `Status "${status.label}" removed`, tone: "info" });
              }}
              onMoveUp={() => moveStatus(idx, -1)}
              onMoveDown={() => moveStatus(idx, 1)}
              isFirst={idx === 0}
              isLast={idx === statuses.length - 1}
            />
          ))}
        </div>

        {showNewStatus && (
          <div className="mt-3 p-3 rounded-md bg-muted/30 border border-border space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={newStatusLabel}
                onChange={(e) => setNewStatusLabel(e.target.value)}
                placeholder="Status name"
                className="h-7 text-xs flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") addStatus(); }}
                autoFocus
              />
              <select
                value={newStatusCategory}
                onChange={(e) => setNewStatusCategory(e.target.value as "open" | "closed")}
                className="h-7 text-xs bg-background border border-border rounded px-2"
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setShowNewStatus(false)}>Cancel</Button>
              <Button size="sm" onClick={addStatus} disabled={!newStatusLabel.trim()}>
                <Save className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
          </div>
        )}

        {/* Category mapping summary */}
        <div className="mt-4 pt-3 border-t border-border">
          <h3 className="text-xs font-medium text-muted-foreground mb-2">Status Category Mapping</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-[10px] font-medium text-blue-600 dark:text-blue-400 uppercase tracking-wider mb-1">Open</p>
              <div className="space-y-0.5">
                {statuses.filter((s) => s.category === "open").map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5 text-xs">
                    <div className={cn("h-2 w-2 rounded-full", s.color)} />
                    {s.label}
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-[10px] font-medium text-green-600 dark:text-green-400 uppercase tracking-wider mb-1">Closed</p>
              <div className="space-y-0.5">
                {statuses.filter((s) => s.category === "closed").map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5 text-xs">
                    <div className={cn("h-2 w-2 rounded-full", s.color)} />
                    {s.label}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Custom fields */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Custom Fields</h2>
            <span className="text-[10px] text-muted-foreground">
              {fields.length} field{fields.length !== 1 ? "s" : ""}
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowNewField(true)}>
            <Plus className="h-3 w-3 mr-1" />
            Add Field
          </Button>
        </div>

        {fields.length === 0 && !showNewField && (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No custom fields defined. Add fields to track additional information on issues.
          </p>
        )}

        <div className="space-y-0">
          {fields.map((field) => (
            <CustomFieldRow
              key={field.id}
              field={field}
              onUpdate={(updated) => {
                persistFields(fields.map((f) => f.id === updated.id ? updated : f));
              }}
              onDelete={() => {
                persistFields(fields.filter((f) => f.id !== field.id));
                pushToast({ title: `Field "${field.name}" removed`, tone: "info" });
              }}
            />
          ))}
        </div>

        {showNewField && (
          <div className="mt-3 p-3 rounded-md bg-muted/30 border border-border space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={newFieldName}
                onChange={(e) => setNewFieldName(e.target.value)}
                placeholder="Field name"
                className="h-7 text-xs flex-1"
                onKeyDown={(e) => { if (e.key === "Enter") addField(); }}
                autoFocus
              />
              <select
                value={newFieldType}
                onChange={(e) => setNewFieldType(e.target.value as CustomField["type"])}
                className="h-7 text-xs bg-background border border-border rounded px-2"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            {newFieldType === "select" && (
              <Input
                value={newFieldOptions}
                onChange={(e) => setNewFieldOptions(e.target.value)}
                placeholder="Options (comma-separated): opt1, opt2, opt3"
                className="h-7 text-xs"
              />
            )}
            <div className="flex items-center gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setShowNewField(false)}>Cancel</Button>
              <Button size="sm" onClick={addField} disabled={!newFieldName.trim()}>
                <Save className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
