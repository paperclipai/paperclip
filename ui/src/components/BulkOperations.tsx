import { memo, useCallback, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ArrowRight,
  Check,
  CheckSquare,
  Copy,
  Download,
  FileUp,
  Layers,
  Plus,
  Settings2,
  Square,
  Tag,
  Trash2,
  Upload,
  X,
  AlertTriangle,
} from "lucide-react";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// CSV Import for Issues
// ---------------------------------------------------------------------------

interface CsvColumn {
  header: string;
  index: number;
  sample: string[];
}

interface ColumnMapping {
  title: number | null;
  description: number | null;
  status: number | null;
  priority: number | null;
  assignee: number | null;
  labels: number | null;
  project: number | null;
}

function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(parseCsvLine);
  return { headers, rows };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function detectDuplicates(rows: string[][], titleIndex: number | null): Set<number> {
  const dupes = new Set<number>();
  if (titleIndex === null) return dupes;
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const title = row[titleIndex]?.toLowerCase().trim() ?? "";
    if (title && seen.has(title)) {
      dupes.add(i);
      dupes.add(seen.get(title)!);
    } else if (title) {
      seen.set(title, i);
    }
  });
  return dupes;
}

interface CsvImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImport: (issues: Array<{
    title: string;
    description?: string;
    status?: string;
    priority?: string;
    labels?: string[];
  }>) => void;
  existingTitles?: string[];
}

export function CsvImportDialog({ open, onClose, onImport, existingTitles = [] }: CsvImportDialogProps) {
  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [csvData, setCsvData] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({
    title: null, description: null, status: null, priority: null,
    assignee: null, labels: null, project: null,
  });
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const data = parseCsv(text);
      setCsvData(data);

      // Auto-map columns by header name
      const autoMap: ColumnMapping = {
        title: null, description: null, status: null, priority: null,
        assignee: null, labels: null, project: null,
      };
      data.headers.forEach((h, i) => {
        const lower = h.toLowerCase().trim();
        if (lower === "title" || lower === "name" || lower === "summary") autoMap.title = i;
        else if (lower === "description" || lower === "body" || lower === "details") autoMap.description = i;
        else if (lower === "status" || lower === "state") autoMap.status = i;
        else if (lower === "priority") autoMap.priority = i;
        else if (lower === "assignee" || lower === "assigned") autoMap.assignee = i;
        else if (lower === "labels" || lower === "tags") autoMap.labels = i;
        else if (lower === "project") autoMap.project = i;
      });
      setMapping(autoMap);
      setSelectedRows(new Set(data.rows.map((_, i) => i)));
      setStep("map");
    };
    reader.readAsText(file);
  }

  function handleImport() {
    if (!csvData || mapping.title === null) return;

    const existingSet = new Set(existingTitles.map((t) => t.toLowerCase().trim()));
    const issues = Array.from(selectedRows)
      .sort((a, b) => a - b)
      .map((i) => {
        const row = csvData.rows[i];
        return {
          title: row[mapping.title!] ?? "",
          description: mapping.description !== null ? row[mapping.description] : undefined,
          status: mapping.status !== null ? row[mapping.status] : undefined,
          priority: mapping.priority !== null ? row[mapping.priority] : undefined,
          labels: mapping.labels !== null
            ? row[mapping.labels]?.split(/[,;]/).map((l) => l.trim()).filter(Boolean)
            : undefined,
        };
      })
      .filter((issue) => issue.title.trim().length > 0);

    onImport(issues);
    handleReset();
    onClose();
  }

  function handleReset() {
    setCsvData(null);
    setMapping({ title: null, description: null, status: null, priority: null, assignee: null, labels: null, project: null });
    setSelectedRows(new Set());
    setStep("upload");
  }

  const duplicateRows = useMemo(() => {
    if (!csvData) return new Set<number>();
    return detectDuplicates(csvData.rows, mapping.title);
  }, [csvData, mapping.title]);

  const existingDupes = useMemo(() => {
    if (!csvData || mapping.title === null) return new Set<number>();
    const existing = new Set(existingTitles.map((t) => t.toLowerCase().trim()));
    const dupes = new Set<number>();
    csvData.rows.forEach((row, i) => {
      const title = row[mapping.title!]?.toLowerCase().trim() ?? "";
      if (title && existing.has(title)) dupes.add(i);
    });
    return dupes;
  }, [csvData, mapping.title, existingTitles]);

  const FIELD_KEYS: Array<{ key: keyof ColumnMapping; label: string }> = [
    { key: "title", label: "Title (required)" },
    { key: "description", label: "Description" },
    { key: "status", label: "Status" },
    { key: "priority", label: "Priority" },
    { key: "assignee", label: "Assignee" },
    { key: "labels", label: "Labels" },
    { key: "project", label: "Project" },
  ];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[80vh] overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in fade-in-0 zoom-in-95 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Import Missions from CSV</h2>
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {step === "upload" && (
            <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-border rounded-lg">
              <FileUp className="h-10 w-10 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground mb-4">
                Upload a CSV file with your issues
              </p>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
              <Button onClick={() => fileRef.current?.click()}>
                <Upload className="h-4 w-4 mr-2" />
                Choose CSV File
              </Button>
              <p className="text-xs text-muted-foreground mt-3">
                Required: title column. Optional: description, status, priority, labels
              </p>
            </div>
          )}

          {step === "map" && csvData && (
            <div className="space-y-6">
              <div>
                <h3 className="text-sm font-semibold mb-3">Map CSV Columns</h3>
                <div className="grid grid-cols-2 gap-3">
                  {FIELD_KEYS.map(({ key, label }) => (
                    <div key={key} className="flex items-center gap-2">
                      <label className="text-xs text-muted-foreground w-32 shrink-0">{label}</label>
                      <select
                        value={mapping[key] ?? "__unmapped__"}
                        onChange={(e) => setMapping((prev) => ({
                          ...prev,
                          [key]: e.target.value === "__unmapped__" ? null : Number(e.target.value),
                        }))}
                        className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <option value="__unmapped__">-- Skip --</option>
                        {csvData.headers.map((h, i) => (
                          <option key={i} value={i}>{h}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              <Button
                onClick={() => setStep("preview")}
                disabled={mapping.title === null}
              >
                Preview Import
                <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          )}

          {step === "preview" && csvData && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">
                  Preview ({selectedRows.size} of {csvData.rows.length} rows selected)
                </h3>
                <div className="flex items-center gap-2">
                  {duplicateRows.size > 0 && (
                    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      {duplicateRows.size} potential duplicates
                    </span>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => setStep("map")} className="text-xs">
                    Back to mapping
                  </Button>
                </div>
              </div>

              <div className="border border-border rounded-lg overflow-x-auto max-h-[400px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left w-8">
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedRows.size === csvData.rows.length) {
                              setSelectedRows(new Set());
                            } else {
                              setSelectedRows(new Set(csvData.rows.map((_, i) => i)));
                            }
                          }}
                        >
                          {selectedRows.size === csvData.rows.length ? (
                            <CheckSquare className="h-3.5 w-3.5" />
                          ) : (
                            <Square className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </th>
                      <th className="px-3 py-2 text-left">#</th>
                      {FIELD_KEYS.filter(({ key }) => mapping[key] !== null).map(({ key, label }) => (
                        <th key={key} className="px-3 py-2 text-left font-medium text-muted-foreground">
                          {label.replace(" (required)", "")}
                        </th>
                      ))}
                      <th className="px-3 py-2 text-left w-16">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {csvData.rows.map((row, i) => {
                      const isDupe = duplicateRows.has(i);
                      const isExisting = existingDupes.has(i);
                      return (
                        <tr
                          key={i}
                          className={cn(
                            "hover:bg-accent/30",
                            isDupe && "bg-amber-500/5",
                            isExisting && "bg-red-500/5",
                          )}
                        >
                          <td className="px-3 py-2">
                            <button type="button" onClick={() => {
                              setSelectedRows((prev) => {
                                const next = new Set(prev);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                return next;
                              });
                            }}>
                              {selectedRows.has(i) ? (
                                <CheckSquare className="h-3.5 w-3.5 text-primary" />
                              ) : (
                                <Square className="h-3.5 w-3.5 text-muted-foreground" />
                              )}
                            </button>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{i + 1}</td>
                          {FIELD_KEYS.filter(({ key }) => mapping[key] !== null).map(({ key }) => (
                            <td key={key} className="px-3 py-2 max-w-[200px] truncate">
                              {row[mapping[key]!] ?? ""}
                            </td>
                          ))}
                          <td className="px-3 py-2">
                            {isExisting ? (
                              <span className="text-red-500 text-[10px]">Exists</span>
                            ) : isDupe ? (
                              <span className="text-amber-500 text-[10px]">Dupe</span>
                            ) : (
                              <span className="text-green-500 text-[10px]">New</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {step === "preview" && (
          <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
            <Button variant="ghost" onClick={handleReset}>
              Start over
            </Button>
            <Button onClick={handleImport} disabled={selectedRows.size === 0 || mapping.title === null}>
              <Upload className="h-4 w-4 mr-2" />
              Import {selectedRows.size} issue{selectedRows.size !== 1 ? "s" : ""}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Actions Bar
// ---------------------------------------------------------------------------

interface BulkActionsBarProps {
  selectedCount: number;
  onClear: () => void;
  onMove?: () => void;
  onLabel?: () => void;
  onDelete?: () => void;
  onStatusChange?: (status: string) => void;
  onPriorityChange?: (priority: string) => void;
  className?: string;
}

export function BulkActionsBar({
  selectedCount,
  onClear,
  onMove,
  onLabel,
  onDelete,
  onStatusChange,
  onPriorityChange,
  className,
}: BulkActionsBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div
      className={cn(
        "sticky bottom-4 z-30 mx-auto flex w-fit items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200",
        className,
      )}
      role="toolbar"
      aria-label={`Bulk actions for ${selectedCount} selected items`}
    >
      <span className="text-xs font-medium text-muted-foreground">
        {selectedCount} selected
      </span>
      <div className="h-4 w-px bg-border" />

      {onStatusChange && (
        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) onStatusChange(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="" disabled>Set status...</option>
          <option value="todo">To Do</option>
          <option value="in_progress">In Progress</option>
          <option value="in_review">In Review</option>
          <option value="done">Done</option>
          <option value="backlog">Backlog</option>
        </select>
      )}

      {onPriorityChange && (
        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-xs"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) onPriorityChange(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="" disabled>Set priority...</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      )}

      {onMove && (
        <Button variant="ghost" size="sm" onClick={onMove} className="h-7 text-xs gap-1">
          <ArrowRight className="h-3 w-3" />
          Move
        </Button>
      )}

      {onLabel && (
        <Button variant="ghost" size="sm" onClick={onLabel} className="h-7 text-xs gap-1">
          <Tag className="h-3 w-3" />
          Label
        </Button>
      )}

      {onDelete && (
        <Button variant="ghost" size="sm" onClick={onDelete} className="h-7 text-xs gap-1 text-destructive hover:text-destructive">
          <Trash2 className="h-3 w-3" />
          Delete
        </Button>
      )}

      <div className="h-4 w-px bg-border" />
      <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs">
        <X className="h-3 w-3 mr-1" />
        Clear
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk Agent Config
// ---------------------------------------------------------------------------

interface BulkAgentConfigProps {
  open: boolean;
  onClose: () => void;
  selectedAgentIds: string[];
  onApply: (agentIds: string[], config: Record<string, unknown>) => void;
}

export function BulkAgentConfigDialog({ open, onClose, selectedAgentIds, onApply }: BulkAgentConfigProps) {
  const [model, setModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [autoApproval, setAutoApproval] = useState<"" | "true" | "false">("");

  if (!open) return null;

  function handleApply() {
    const config: Record<string, unknown> = {};
    if (model) config.model = model;
    if (maxTokens) config.maxTokens = Number(maxTokens);
    if (autoApproval) config.autoApproval = autoApproval === "true";
    onApply(selectedAgentIds, config);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-4">
          <Settings2 className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Bulk Agent Configuration</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Apply settings to {selectedAgentIds.length} selected agent{selectedAgentIds.length !== 1 ? "s" : ""}.
          Only filled fields will be updated.
        </p>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Leave blank to keep current"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Max Tokens</label>
            <Input
              type="number"
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              placeholder="Leave blank to keep current"
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Auto-approval</label>
            <select
              value={autoApproval}
              onChange={(e) => setAutoApproval(e.target.value as "" | "true" | "false")}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">No change</option>
              <option value="true">Enable</option>
              <option value="false">Disable</option>
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleApply}>
            Apply to {selectedAgentIds.length} agent{selectedAgentIds.length !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue Templates
// ---------------------------------------------------------------------------

export interface IssueTemplate {
  id: string;
  name: string;
  icon: string;
  defaults: {
    title?: string;
    description?: string;
    priority?: string;
    labels?: string[];
  };
}

export const BUILT_IN_TEMPLATES: IssueTemplate[] = [
  {
    id: "bug",
    name: "Bug Report",
    icon: "bug",
    defaults: {
      title: "[Bug] ",
      description: "## Steps to Reproduce\n1. \n\n## Expected Behavior\n\n\n## Actual Behavior\n\n\n## Environment\n- \n",
      priority: "high",
      labels: ["bug"],
    },
  },
  {
    id: "feature",
    name: "Feature Request",
    icon: "lightbulb",
    defaults: {
      title: "[Feature] ",
      description: "## Summary\n\n\n## Motivation\n\n\n## Proposed Solution\n\n\n## Alternatives Considered\n\n",
      priority: "medium",
      labels: ["feature"],
    },
  },
  {
    id: "research",
    name: "Research Task",
    icon: "search",
    defaults: {
      title: "[Research] ",
      description: "## Objective\n\n\n## Scope\n\n\n## Key Questions\n1. \n\n## Deliverables\n- \n",
      priority: "medium",
      labels: ["research"],
    },
  },
  {
    id: "chore",
    name: "Maintenance / Chore",
    icon: "wrench",
    defaults: {
      title: "[Chore] ",
      description: "## Description\n\n\n## Tasks\n- [ ] \n",
      priority: "low",
      labels: ["chore"],
    },
  },
];

interface TemplatePickerProps {
  templates?: IssueTemplate[];
  onSelect: (template: IssueTemplate) => void;
  className?: string;
}

export function TemplatePicker({ templates = BUILT_IN_TEMPLATES, onSelect, className }: TemplatePickerProps) {
  return (
    <div className={cn("grid grid-cols-2 gap-2", className)}>
      {templates.map((tmpl) => (
        <button
          key={tmpl.id}
          type="button"
          onClick={() => onSelect(tmpl)}
          className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors"
        >
          <Layers className="h-4 w-4 text-muted-foreground shrink-0" />
          <span>{tmpl.name}</span>
        </button>
      ))}
      <button
        type="button"
        className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-accent/50 transition-colors"
        onClick={() => onSelect({
          id: "blank",
          name: "Blank Issue",
          icon: "file",
          defaults: {},
        })}
      >
        <Plus className="h-4 w-4 shrink-0" />
        <span>Blank</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Config Export/Import
// ---------------------------------------------------------------------------

export function exportAgentConfig(agents: Array<{ id: string; name: string; [key: string]: unknown }>) {
  const data = agents.map(({ id, ...rest }) => rest);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `agent-configs-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importAgentConfig(file: File): Promise<Array<Record<string, unknown>>> {
  const text = await file.text();
  return JSON.parse(text) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Bulk Label Application
// ---------------------------------------------------------------------------

interface BulkLabelDialogProps {
  open: boolean;
  onClose: () => void;
  selectedCount: number;
  availableLabels: string[];
  onApply: (labels: string[]) => void;
}

export function BulkLabelDialog({ open, onClose, selectedCount, availableLabels, onApply }: BulkLabelDialogProps) {
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
  const [newLabel, setNewLabel] = useState("");

  if (!open) return null;

  function toggleLabel(label: string) {
    setSelectedLabels((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  function addCustomLabel() {
    const trimmed = newLabel.trim();
    if (trimmed && !selectedLabels.has(trimmed)) {
      setSelectedLabels((prev) => new Set([...prev, trimmed]));
      setNewLabel("");
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-border bg-card p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-4">
          <Tag className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Apply Labels</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Apply to {selectedCount} selected issue{selectedCount !== 1 ? "s" : ""}
        </p>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {availableLabels.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => toggleLabel(label)}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs border transition-colors",
                selectedLabels.has(label)
                  ? "border-primary bg-primary/10 text-primary font-medium"
                  : "border-border hover:border-primary/40",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 mb-4">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="New label..."
            className="h-8 text-xs"
            onKeyDown={(e) => { if (e.key === "Enter") addCustomLabel(); }}
          />
          <Button variant="ghost" size="sm" onClick={addCustomLabel} className="h-8 text-xs shrink-0">
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => { onApply([...selectedLabels]); onClose(); }} disabled={selectedLabels.size === 0}>
            Apply {selectedLabels.size} label{selectedLabels.size !== 1 ? "s" : ""}
          </Button>
        </div>
      </div>
    </div>
  );
}
