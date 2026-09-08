import { useEffect, useState } from "react";
import { Pill, Check, X, RotateCcw, ChevronLeft, ChevronRight, Plus, Pencil, Trash2 } from "lucide-react";
import {
  useSupplementsIntake,
  useTakeSupplement,
  useSkipSupplement,
  useUndoSupplement,
  useSupplementsList,
  useAddSupplement,
  useEditSupplement,
  useDeleteSupplement,
  formatIntakeDate,
  type SupplementIntake,
  type Supplement,
} from "../hooks/useSupplements";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

function offsetDate(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function isToday(date: Date): boolean {
  return formatIntakeDate(date) === formatIntakeDate(new Date());
}

interface IntakeRowProps {
  intake: SupplementIntake;
  date: string;
}

function IntakeRow({ intake, date }: IntakeRowProps) {
  const takeMutation = useTakeSupplement(date);
  const skipMutation = useSkipSupplement(date);
  const undoMutation = useUndoSupplement(date);
  const isBusy = takeMutation.isPending || skipMutation.isPending || undoMutation.isPending;

  const taken = !!intake.takenAt;
  const skipped = !!intake.skippedAt;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0",
        taken && "bg-green-50/50 dark:bg-green-950/20",
        skipped && "bg-muted/40",
      )}
    >
      <div className="flex-1 min-w-0">
        <p className={cn("text-sm font-medium truncate", skipped && "text-muted-foreground line-through")}>
          {intake.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {intake.dose} {intake.unit}
        </p>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {taken || skipped ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={isBusy}
            onClick={() => undoMutation.mutate(intake.supplementId)}
            className="h-7 w-7 p-0 text-muted-foreground"
            title="Undo"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => takeMutation.mutate(intake.supplementId)}
              className="h-7 w-7 p-0 text-green-600 hover:text-green-700 hover:bg-green-50"
              title="Take"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isBusy}
              onClick={() => skipMutation.mutate(intake.supplementId)}
              className="h-7 w-7 p-0 text-muted-foreground"
              title="Skip"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        )}
      </div>

      <div className="shrink-0 w-16 text-right">
        {taken && <span className="text-xs font-medium text-green-600">Taken</span>}
        {skipped && <span className="text-xs text-muted-foreground">Skipped</span>}
        {!taken && !skipped && <span className="text-xs text-muted-foreground">Pending</span>}
      </div>
    </div>
  );
}

// ---- Supplement form for add / edit ----

interface SupplementFormState {
  name: string;
  dose: string;
  unit: string;
  scheduledTime: string;
  notes: string;
}

const EMPTY_FORM: SupplementFormState = {
  name: "",
  dose: "",
  unit: "mg",
  scheduledTime: "08:00",
  notes: "",
};

interface SupplementDialogProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
  editing: Supplement | null;
}

function SupplementDialog({ open, onClose, companyId, editing }: SupplementDialogProps) {
  const addMutation = useAddSupplement();
  const editMutation = useEditSupplement();

  const [form, setForm] = useState<SupplementFormState>(EMPTY_FORM);
  const isBusy = addMutation.isPending || editMutation.isPending;

  useEffect(() => {
    if (open) {
      setForm(
        editing
          ? { name: editing.name, dose: editing.dose, unit: editing.unit, scheduledTime: editing.scheduledTime, notes: editing.notes ?? "" }
          : EMPTY_FORM,
      );
    }
  }, [open, editing]);

  function field(key: keyof SupplementFormState) {
    return {
      value: form[key],
      onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
        setForm((prev) => ({ ...prev, [key]: e.target.value })),
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const base = { name: form.name.trim(), dose: form.dose.trim(), unit: form.unit.trim(), scheduledTime: form.scheduledTime, notes: form.notes.trim() || undefined };
    if (editing) {
      await editMutation.mutateAsync({ id: editing.id, companyId, ...base });
    } else {
      await addMutation.mutateAsync({ companyId, ...base });
    }
    onClose();
  }

  const error = (addMutation.error ?? editMutation.error) instanceof Error
    ? (addMutation.error ?? editMutation.error as Error).message
    : null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit supplement" : "Add supplement"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => { void handleSubmit(e); }} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input
              {...field("name")}
              required
              placeholder="e.g. Vitamin D3"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Dose</label>
              <input
                {...field("dose")}
                required
                placeholder="e.g. 2000"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            <div className="w-20 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Unit</label>
              <input
                {...field("unit")}
                placeholder="mg"
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Scheduled time</label>
            <input
              {...field("scheduledTime")}
              type="time"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Notes (optional)</label>
            <input
              {...field("notes")}
              placeholder="e.g. Take with food"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={isBusy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isBusy || !form.name.trim() || !form.dose.trim()}>
              {isBusy ? "Saving…" : editing ? "Save changes" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Manage view ----

interface ManageViewProps {
  companyId: string;
}

function ManageView({ companyId }: ManageViewProps) {
  const { data: supplements = [], isLoading, error } = useSupplementsList(companyId);
  const deleteMutation = useDeleteSupplement();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Supplement | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  function openAdd() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(s: Supplement) {
    setEditing(s);
    setDialogOpen(true);
  }

  async function handleDelete(id: string) {
    await deleteMutation.mutateAsync({ id, companyId });
    setConfirming(null);
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{supplements.length} supplement{supplements.length !== 1 ? "s" : ""} configured</p>
        <Button size="sm" onClick={openAdd}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>

      {error instanceof Error && (
        <p className="text-sm text-destructive">{error.message}</p>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {supplements.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No supplements yet. Add one to get started.
          </div>
        ) : (
          supplements.map((s) => (
            <div key={s.id} className={cn("flex items-center gap-3 px-4 py-3 border-b border-border last:border-b-0", !s.active && "opacity-50")}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{s.name}</p>
                <p className="text-xs text-muted-foreground">
                  {s.dose} {s.unit} · {s.scheduledTime}
                  {s.notes && ` · ${s.notes}`}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground"
                  onClick={() => openEdit(s)}
                  title="Edit"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                {confirming === s.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-destructive"
                      disabled={deleteMutation.isPending}
                      onClick={() => { void handleDelete(s.id); }}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => setConfirming(null)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirming(s.id)}
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <SupplementDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        companyId={companyId}
        editing={editing}
      />
    </div>
  );
}

// ---- Daily view ----

interface DailyViewProps {
  companyId: string;
}

function DailyView({ companyId: _companyId }: DailyViewProps) {
  const [activeDate, setActiveDate] = useState<Date>(new Date());
  const dateStr = formatIntakeDate(activeDate);
  const { data, isLoading, error } = useSupplementsIntake(dateStr);
  const intakes = data?.intakes ?? [];

  return (
    <div className="space-y-4">
      {/* Date navigation */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setActiveDate((d) => offsetDate(d, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="text-center">
          <p className="text-sm font-medium">{formatDisplayDate(activeDate)}</p>
          {isToday(activeDate) && <p className="text-xs text-muted-foreground">Today</p>}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setActiveDate((d) => offsetDate(d, 1))}
          disabled={isToday(activeDate)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {error instanceof Error && (
        <p className="text-sm text-destructive">{error.message}</p>
      )}

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : intakes.length === 0 ? (
        <EmptyState icon={Pill} message="No supplements scheduled for this day." />
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-muted/30 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Today&apos;s supplements</p>
            <p className="text-xs text-muted-foreground">
              {intakes.filter((i) => !!i.takenAt).length}/{intakes.length} taken
            </p>
          </div>
          {intakes.map((intake) => (
            <IntakeRow key={intake.supplementId} intake={intake} date={dateStr} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Page ----

export function Supplements() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [view, setView] = useState<"daily" | "manage">("daily");

  useEffect(() => {
    setBreadcrumbs([{ label: "Supplements" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Pill} message="Select a company to view supplements." />;
  }

  return (
    <div className="space-y-4">
      {/* View toggle */}
      <div className="flex gap-1 p-0.5 rounded-md bg-muted w-fit">
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "daily" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("daily")}
        >
          Daily
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "manage" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("manage")}
        >
          Manage
        </button>
      </div>

      {view === "daily" ? (
        <DailyView companyId={selectedCompanyId} />
      ) : (
        <ManageView companyId={selectedCompanyId} />
      )}
    </div>
  );
}
