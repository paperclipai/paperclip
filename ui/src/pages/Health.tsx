import { useEffect, useState } from "react";
import { Activity, AlertCircle, ChevronDown, ChevronUp, Dumbbell, Heart, Leaf, MapPin, Moon, Pencil, Plus, Smile, Sun, Thermometer, Trash2, Weight, Wind, Zap } from "lucide-react";
import {
  usePersonalEnvironmentalScore,
  type ColorTier,
  type PersonalScoreHistoryEntry,
} from "../hooks/useEnvironmentalScore";
import {
  useLocationsList,
  useLocationReadings,
  useAddLocation,
  useEditLocation,
  useDeleteLocation,
  type UserLocation,
  type EnvironmentalReading,
} from "../hooks/useLocations";
import {
  useSleepHistory,
  useLogSleep,
  useDeleteSleepRecord,
  type SleepQuality,
  type SleepRecord,
} from "../hooks/useSleep";
import {
  useExerciseHistory,
  useLogExercise,
  useDeleteExerciseLog,
  type ActivityType,
  type IntensityLevel,
  type ExerciseLog,
} from "../hooks/useExercise";
import {
  useBiometricsHistory,
  useLogBiometrics,
  useDeleteBiometricReading,
  type BiometricReading,
} from "../hooks/useBiometrics";
import {
  useMoodHistory,
  useLogMood,
  useDeleteMoodLog,
  type MoodLog,
} from "../hooks/useMood";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

// ---- Environmental Score helpers ----

const TIER_CLASSES: Record<ColorTier, { bg: string; text: string; bar: string }> = {
  green:  { bg: "bg-green-100/80 border-green-200",  text: "text-green-700",  bar: "bg-green-500" },
  yellow: { bg: "bg-yellow-100/80 border-yellow-200", text: "text-yellow-700", bar: "bg-yellow-500" },
  orange: { bg: "bg-orange-100/80 border-orange-200", text: "text-orange-700", bar: "bg-orange-500" },
  red:    { bg: "bg-red-100/80 border-red-200",   text: "text-red-700",   bar: "bg-red-500" },
};

const TIER_LABEL: Record<ColorTier, string> = {
  green: "Good",
  yellow: "Moderate",
  orange: "Sensitive",
  red: "Unhealthy",
};

function ScoreCircle({ score, colorTier }: { score: number; colorTier: ColorTier }) {
  const t = TIER_CLASSES[colorTier];
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-full h-28 w-28 border-2 shrink-0", t.bg, t.text)}>
      <span className="text-4xl font-bold tabular-nums leading-none">{score}</span>
      <span className="text-xs font-medium mt-1 uppercase tracking-wide">{TIER_LABEL[colorTier]}</span>
    </div>
  );
}

function ComponentTile({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number | null;
  icon: React.ElementType;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 space-y-1.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="text-xl font-semibold tabular-nums">
        {value != null ? value : "—"}
      </p>
    </div>
  );
}

function HistoryBar({ entry }: { entry: PersonalScoreHistoryEntry }) {
  const t = TIER_CLASSES[entry.colorTier];
  const height = `${Math.max(8, entry.score)}%`;
  const date = new Date(entry.scoredAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div className="flex flex-col items-center gap-1 flex-1 min-w-0" title={`${date}: ${entry.score}`}>
      <div className="w-full flex flex-col justify-end" style={{ height: "48px" }}>
        <div
          className={cn("w-full rounded-sm", t.bar)}
          style={{ height }}
        />
      </div>
    </div>
  );
}

// ---- Score view ----

function ScoreView({ companyId }: { companyId: string }) {
  const { data, isLoading, error } = usePersonalEnvironmentalScore(companyId);

  if (isLoading) return <PageSkeleton variant="dashboard" />;

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{error instanceof Error ? error.message : "Failed to load environmental score"}</span>
      </div>
    );
  }

  const today = data?.today ?? null;
  const history = data?.history ?? [];

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border bg-card p-5">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
          Today's Environmental Score
        </p>
        {today ? (
          <div className="flex items-center gap-5 flex-wrap">
            <ScoreCircle score={today.score} colorTier={today.colorTier} />
            <div className="space-y-1 text-sm">
              {today.confidenceFlag && (
                <p className="text-xs text-muted-foreground">
                  Low confidence signal{today.partialSignals.length > 0 ? `: ${today.partialSignals.join(", ")}` : ""}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Updated {new Date(today.scoredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No score recorded yet for today.</p>
        )}
      </div>

      {today && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Component Scores
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <ComponentTile label="AQI" value={today.components.aqi} icon={Wind} />
            <ComponentTile label="UV" value={today.components.uv} icon={Sun} />
            <ComponentTile label="Heat Stress" value={today.components.heatStress} icon={Thermometer} />
            <ComponentTile label="Greenspace" value={today.components.greenspace} icon={Leaf} />
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              30-day History
            </p>
          </div>
          <div className="px-4 py-3 flex items-end gap-0.5">
            {history.slice(0, 30).map((entry, i) => (
              <HistoryBar key={i} entry={entry} />
            ))}
          </div>
        </div>
      )}

      {data?.disclaimer && (
        <p className="text-xs text-muted-foreground border-t border-border pt-4">
          {data.disclaimer}
        </p>
      )}
    </div>
  );
}

// ---- Location dialog ----

interface LocationDialogProps {
  open: boolean;
  companyId: string;
  existing?: UserLocation;
  onClose: () => void;
}

function LocationDialog({ open, companyId, existing, onClose }: LocationDialogProps) {
  const addMutation = useAddLocation();
  const editMutation = useEditLocation();
  const isEdit = !!existing;

  const [label, setLabel] = useState(existing?.label ?? "");
  const [lat, setLat] = useState(existing ? String(existing.lat) : "");
  const [lng, setLng] = useState(existing ? String(existing.lng) : "");
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setLabel(existing?.label ?? "");
      setLat(existing ? String(existing.lat) : "");
      setLng(existing ? String(existing.lng) : "");
      setIsDefault(existing?.isDefault ?? false);
      setErr(null);
    }
  }, [open, existing]);

  const busy = addMutation.isPending || editMutation.isPending;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    if (isNaN(latNum) || isNaN(lngNum)) {
      setErr("Latitude and longitude must be valid numbers.");
      return;
    }
    try {
      if (isEdit && existing) {
        await editMutation.mutateAsync({
          id: existing.id,
          companyId,
          lat: latNum,
          lng: lngNum,
          label: label.trim() || null,
          isDefault,
        });
      } else {
        await addMutation.mutateAsync({
          companyId,
          lat: latNum,
          lng: lngNum,
          label: label.trim() || undefined,
          isDefault,
        });
      }
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "An error occurred.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Location" : "Add Location"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">Label (optional)</label>
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              placeholder="e.g. Home, Office"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Latitude</label>
              <input
                required
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="37.7749"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Longitude</label>
              <input
                required
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                placeholder="-122.4194"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="rounded border-border"
            />
            Set as default location
          </label>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              {isEdit ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- Readings panel ----

const AQI_COLOR: (aqi: number | null) => string = (aqi) => {
  if (aqi == null) return "text-muted-foreground";
  if (aqi <= 50) return "text-green-600";
  if (aqi <= 100) return "text-yellow-600";
  if (aqi <= 150) return "text-orange-500";
  return "text-red-600";
};

function ReadingRow({ reading }: { reading: EnvironmentalReading }) {
  const date = new Date(reading.readingAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0 text-xs">
      <span className="text-muted-foreground w-28 shrink-0">{date}</span>
      <span className={cn("font-semibold tabular-nums w-10 shrink-0", AQI_COLOR(reading.aqi))}>
        {reading.aqi != null ? `AQI ${reading.aqi}` : "—"}
      </span>
      {reading.pm25 != null && (
        <span className="text-muted-foreground">PM2.5 {reading.pm25.toFixed(1)}</span>
      )}
      {reading.pm10 != null && (
        <span className="text-muted-foreground">PM10 {reading.pm10.toFixed(1)}</span>
      )}
      <span className="ml-auto text-muted-foreground/70 capitalize">{reading.dataSource}</span>
    </div>
  );
}

function LocationReadingsPanel({ locationId, companyId }: { locationId: string; companyId: string }) {
  const { data, isLoading, error } = useLocationReadings(locationId, companyId);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground py-2 px-4">Loading readings…</p>;
  }

  if (error) {
    return (
      <p className="text-xs text-destructive py-2 px-4">
        {error instanceof Error ? error.message : "Failed to load readings"}
      </p>
    );
  }

  if (!data || data.readings.length === 0) {
    return <p className="text-xs text-muted-foreground py-2 px-4">No readings in the last 7 days.</p>;
  }

  return (
    <div className="px-4 pb-3 pt-1 bg-muted/30">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium mb-1">
        Recent readings
      </p>
      {data.readings.slice(0, 10).map((r) => (
        <ReadingRow key={r.id} reading={r} />
      ))}
    </div>
  );
}

// ---- Location row ----

interface LocationRowProps {
  location: UserLocation;
  companyId: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdit: (loc: UserLocation) => void;
}

function LocationRow({ location, companyId, isExpanded, onToggleExpand, onEdit }: LocationRowProps) {
  const deleteMutation = useDeleteLocation();
  const editMutation = useEditLocation();
  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return; }
    deleteMutation.mutate({ id: location.id, companyId });
  }

  function handleSetDefault() {
    editMutation.mutate({ id: location.id, companyId, isDefault: true });
  }

  const busy = deleteMutation.isPending || editMutation.isPending;

  const ExpandIcon = isExpanded ? ChevronUp : ChevronDown;

  return (
    <div className="border-b border-border last:border-0">
      <div className="px-4 py-3 flex items-center gap-3">
        <MapPin className="h-4 w-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {location.label ?? <span className="text-muted-foreground italic">Unnamed</span>}
            {location.isDefault && (
              <span className="ml-2 inline-block text-xs bg-primary/10 text-primary rounded px-1.5 py-0.5 font-medium">
                Default
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={onToggleExpand}
            title={isExpanded ? "Hide readings" : "Show readings"}
          >
            <ExpandIcon className="h-3.5 w-3.5" />
          </Button>
          {!location.isDefault && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={handleSetDefault} disabled={busy}>
              Set default
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onEdit(location)} disabled={busy}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-7 w-7 p-0", confirmDelete ? "text-destructive" : "")}
            onClick={handleDelete}
            disabled={busy}
            title={confirmDelete ? "Click again to confirm" : "Delete location"}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      {isExpanded && (
        <LocationReadingsPanel locationId={location.id} companyId={companyId} />
      )}
    </div>
  );
}

// ---- Locations view ----

function LocationsView({ companyId }: { companyId: string }) {
  const { data: locations, isLoading, error } = useLocationsList(companyId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserLocation | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);

  function openAdd() { setEditing(undefined); setDialogOpen(true); }
  function openEdit(loc: UserLocation) { setEditing(loc); setDialogOpen(true); }
  function closeDialog() { setDialogOpen(false); setEditing(undefined); }

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? undefined : id));
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>{error instanceof Error ? error.message : "Failed to load locations"}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {locations?.length ?? 0} saved location{locations?.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={openAdd}>
          <Plus className="h-3.5 w-3.5" />
          Add location
        </Button>
      </div>

      {locations?.length === 0 ? (
        <EmptyState icon={MapPin} message="No saved locations yet. Add one to track environmental data for a specific place." />
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          {locations?.map((loc) => (
            <LocationRow
              key={loc.id}
              location={loc}
              companyId={companyId}
              isExpanded={expandedId === loc.id}
              onToggleExpand={() => toggleExpand(loc.id)}
              onEdit={openEdit}
            />
          ))}
        </div>
      )}

      <LocationDialog
        open={dialogOpen}
        companyId={companyId}
        existing={editing}
        onClose={closeDialog}
      />
    </div>
  );
}

// ---- Sleep view ----

const QUALITY_LABEL: Record<SleepQuality, string> = {
  poor: "Poor",
  fair: "Fair",
  good: "Good",
  excellent: "Excellent",
};

const QUALITY_COLOR: Record<SleepQuality, string> = {
  poor: "text-red-600",
  fair: "text-yellow-600",
  good: "text-green-600",
  excellent: "text-emerald-600",
};

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function SleepBar({ record }: { record: SleepRecord }) {
  const maxMinutes = 10 * 60;
  const pct = Math.min(100, Math.round((record.durationMinutes / maxMinutes) * 100));
  const label = new Date(record.sleepDate + "T00:00:00Z").toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const barColor =
    record.durationMinutes >= 7 * 60
      ? "bg-blue-500"
      : record.durationMinutes >= 6 * 60
        ? "bg-yellow-500"
        : "bg-red-500";
  return (
    <div className="flex flex-col items-center gap-0.5 w-8 shrink-0">
      <span className="text-[9px] text-muted-foreground tabular-nums">
        {record.durationMinutes >= 60
          ? `${Math.floor(record.durationMinutes / 60)}h`
          : `${record.durationMinutes}m`}
      </span>
      <div className="relative h-16 w-full flex items-end">
        <div
          className={cn("w-full rounded-t-sm", barColor)}
          style={{ height: `${pct}%` }}
        />
      </div>
      <span className="text-[9px] text-muted-foreground leading-tight text-center">{label}</span>
    </div>
  );
}

function SleepLogRow({
  record,
  onDelete,
}: {
  record: SleepRecord;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-sm font-medium tabular-nums shrink-0">
          {new Date(record.sleepDate + "T00:00:00Z").toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </span>
        <span className="text-sm tabular-nums text-foreground/80">
          {formatDuration(record.durationMinutes)}
        </span>
        {record.quality && (
          <span className={cn("text-xs font-medium", QUALITY_COLOR[record.quality])}>
            {QUALITY_LABEL[record.quality]}
          </span>
        )}
        {record.notes && (
          <span className="text-xs text-muted-foreground truncate hidden sm:block">
            {record.notes}
          </span>
        )}
      </div>
      {confirmDelete ? (
        <div className="flex gap-1">
          <button
            className="text-xs text-destructive hover:underline"
            onClick={() => onDelete(record.id)}
          >
            Confirm
          </button>
          <button
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="text-muted-foreground hover:text-destructive ml-2 shrink-0"
          onClick={() => setConfirmDelete(true)}
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function SleepView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useSleepHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogSleep();
  const deleteMutation = useDeleteSleepRecord();

  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(today);
  const [formHours, setFormHours] = useState("7");
  const [formMinutes, setFormMinutes] = useState("0");
  const [formQuality, setFormQuality] = useState<SleepQuality | "">("");
  const [formNotes, setFormNotes] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  async function handleLog(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    const h = parseInt(formHours, 10);
    const m = parseInt(formMinutes, 10);
    if (isNaN(h) || isNaN(m) || h < 0 || m < 0 || h > 23 || m > 59 || (h === 0 && m === 0)) {
      setFormErr("Enter a valid duration.");
      return;
    }
    const durationMinutes = h * 60 + m;
    try {
      await logMutation.mutateAsync({
        companyId,
        sleepDate: formDate,
        durationMinutes,
        quality: formQuality || null,
        notes: formNotes.trim() || null,
      });
      setShowForm(false);
      setFormHours("7");
      setFormMinutes("0");
      setFormQuality("");
      setFormNotes("");
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : "Failed to log sleep");
    }
  }

  if (isLoading) return <PageSkeleton />;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error.message}
      </div>
    );
  }

  const records = data?.records ?? [];

  return (
    <div className="space-y-4">
      {/* Bar chart */}
      {records.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-3">Sleep duration — last 14 days (max 10h)</p>
          <div className="flex items-end gap-1 overflow-x-auto pb-1">
            {[...records].reverse().map((r) => (
              <SleepBar key={r.id} record={r} />
            ))}
          </div>
        </div>
      )}

      {/* Log button / form */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Moon className="h-4 w-4 text-blue-400" />
            Sleep Log
          </h3>
          <Button
            size="sm"
            variant={showForm ? "ghost" : "outline"}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Cancel" : <><Plus className="h-3.5 w-3.5 mr-1" />Log sleep</>}
          </Button>
        </div>

        {showForm && (
          <form onSubmit={handleLog} className="space-y-2 pt-1 border-t border-border/50">
            <div className="flex flex-wrap gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Date</label>
                <input
                  type="date"
                  value={formDate}
                  max={today}
                  onChange={(e) => setFormDate(e.target.value)}
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Hours</label>
                <input
                  type="number"
                  value={formHours}
                  min={0}
                  max={23}
                  onChange={(e) => setFormHours(e.target.value)}
                  className="h-8 w-16 rounded border border-border bg-background px-2 text-sm"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Minutes</label>
                <input
                  type="number"
                  value={formMinutes}
                  min={0}
                  max={59}
                  onChange={(e) => setFormMinutes(e.target.value)}
                  className="h-8 w-16 rounded border border-border bg-background px-2 text-sm"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Quality</label>
                <select
                  value={formQuality}
                  onChange={(e) => setFormQuality(e.target.value as SleepQuality | "")}
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                >
                  <option value="">—</option>
                  <option value="poor">Poor</option>
                  <option value="fair">Fair</option>
                  <option value="good">Good</option>
                  <option value="excellent">Excellent</option>
                </select>
              </div>
            </div>
            <input
              type="text"
              placeholder="Notes (optional)"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              className="w-full h-8 rounded border border-border bg-background px-2 text-sm"
            />
            {formErr && <p className="text-xs text-destructive">{formErr}</p>}
            <Button type="submit" size="sm" disabled={logMutation.isPending}>
              {logMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </form>
        )}

        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No sleep records for the last 14 days.</p>
        ) : (
          <div className="divide-y divide-border/30">
            {records.map((r) => (
              <SleepLogRow
                key={r.id}
                record={r}
                onDelete={(id) => deleteMutation.mutate({ id, companyId })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Exercise view ----

const ACTIVITY_LABEL: Record<ActivityType, string> = {
  running: "Running",
  walking: "Walking",
  cycling: "Cycling",
  swimming: "Swimming",
  strength: "Strength",
  yoga: "Yoga",
  hiit: "HIIT",
  stretching: "Stretching",
  other: "Other",
};

const ACTIVITY_TYPES: ActivityType[] = [
  "running", "walking", "cycling", "swimming",
  "strength", "yoga", "hiit", "stretching", "other",
];

const INTENSITY_LABEL: Record<IntensityLevel, string> = {
  light: "Light",
  moderate: "Moderate",
  vigorous: "Vigorous",
};

const INTENSITY_COLOR: Record<IntensityLevel, string> = {
  light: "text-green-600",
  moderate: "text-yellow-600",
  vigorous: "text-red-600",
};

function ExerciseLogRow({
  log,
  onDelete,
}: {
  log: ExerciseLog;
  onDelete: (id: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-sm font-medium tabular-nums shrink-0">
          {new Date(log.exerciseDate + "T00:00:00Z").toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
          })}
        </span>
        <span className="text-sm font-medium shrink-0">{ACTIVITY_LABEL[log.activityType]}</span>
        <span className="text-sm tabular-nums text-foreground/80 shrink-0">
          {formatDuration(log.durationMinutes)}
        </span>
        {log.intensityLevel && (
          <span className={cn("text-xs font-medium shrink-0", INTENSITY_COLOR[log.intensityLevel])}>
            {INTENSITY_LABEL[log.intensityLevel]}
          </span>
        )}
        {log.notes && (
          <span className="text-xs text-muted-foreground truncate hidden sm:block">
            {log.notes}
          </span>
        )}
      </div>
      {confirmDelete ? (
        <div className="flex gap-1">
          <button
            className="text-xs text-destructive hover:underline"
            onClick={() => onDelete(log.id)}
          >
            Confirm
          </button>
          <button
            className="text-xs text-muted-foreground hover:underline"
            onClick={() => setConfirmDelete(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="text-muted-foreground hover:text-destructive ml-2 shrink-0"
          onClick={() => setConfirmDelete(true)}
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ExerciseView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useExerciseHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogExercise();
  const deleteMutation = useDeleteExerciseLog();

  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(today);
  const [formActivity, setFormActivity] = useState<ActivityType>("running");
  const [formHours, setFormHours] = useState("0");
  const [formMinutes, setFormMinutes] = useState("30");
  const [formIntensity, setFormIntensity] = useState<IntensityLevel | "">("");
  const [formNotes, setFormNotes] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  async function handleLog(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    const h = parseInt(formHours, 10);
    const m = parseInt(formMinutes, 10);
    if (isNaN(h) || isNaN(m) || h < 0 || m < 0 || h > 23 || m > 59 || (h === 0 && m === 0)) {
      setFormErr("Enter a valid duration.");
      return;
    }
    const durationMinutes = h * 60 + m;
    try {
      await logMutation.mutateAsync({
        companyId,
        exerciseDate: formDate,
        activityType: formActivity,
        durationMinutes,
        intensityLevel: formIntensity || null,
        notes: formNotes.trim() || null,
      });
      setShowForm(false);
      setFormHours("0");
      setFormMinutes("30");
      setFormIntensity("");
      setFormNotes("");
    } catch (err) {
      setFormErr(err instanceof Error ? err.message : "Failed to log exercise");
    }
  }

  if (isLoading) return <PageSkeleton />;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4" />
        {error.message}
      </div>
    );
  }

  const logs = data?.logs ?? [];

  // Aggregate minutes per date for the bar chart
  const minutesByDate = new Map<string, number>();
  for (const log of logs) {
    minutesByDate.set(log.exerciseDate, (minutesByDate.get(log.exerciseDate) ?? 0) + log.durationMinutes);
  }
  const chartDates = [...minutesByDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  const maxChartMinutes = Math.max(60, ...chartDates.map(([, m]) => m));

  return (
    <div className="space-y-4">
      {/* Bar chart */}
      {chartDates.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-3">Active minutes per day — last 14 days</p>
          <div className="flex items-end gap-1 overflow-x-auto pb-1">
            {chartDates.map(([date, mins]) => {
              const pct = Math.min(100, Math.round((mins / maxChartMinutes) * 100));
              const label = new Date(date + "T00:00:00Z").toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              });
              const barColor = mins >= 60 ? "bg-emerald-500" : mins >= 30 ? "bg-green-400" : "bg-yellow-400";
              return (
                <div key={date} className="flex flex-col items-center gap-0.5 w-8 shrink-0">
                  <span className="text-[9px] text-muted-foreground tabular-nums">
                    {mins >= 60 ? `${Math.floor(mins / 60)}h` : `${mins}m`}
                  </span>
                  <div className="relative h-16 w-full flex items-end">
                    <div className={cn("w-full rounded-t-sm", barColor)} style={{ height: `${pct}%` }} />
                  </div>
                  <span className="text-[9px] text-muted-foreground leading-tight text-center">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Log button / form */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Dumbbell className="h-4 w-4 text-emerald-500" />
            Exercise Log
          </h3>
          <Button
            size="sm"
            variant={showForm ? "ghost" : "outline"}
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Cancel" : <><Plus className="h-3.5 w-3.5 mr-1" />Log workout</>}
          </Button>
        </div>

        {showForm && (
          <form onSubmit={handleLog} className="space-y-2 pt-1 border-t border-border/50">
            <div className="flex flex-wrap gap-2">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Date</label>
                <input
                  type="date"
                  value={formDate}
                  max={today}
                  onChange={(e) => setFormDate(e.target.value)}
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Activity</label>
                <select
                  value={formActivity}
                  onChange={(e) => setFormActivity(e.target.value as ActivityType)}
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                >
                  {ACTIVITY_TYPES.map((t) => (
                    <option key={t} value={t}>{ACTIVITY_LABEL[t]}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Hours</label>
                <input
                  type="number"
                  value={formHours}
                  min={0}
                  max={23}
                  onChange={(e) => setFormHours(e.target.value)}
                  className="h-8 w-16 rounded border border-border bg-background px-2 text-sm"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Minutes</label>
                <input
                  type="number"
                  value={formMinutes}
                  min={0}
                  max={59}
                  onChange={(e) => setFormMinutes(e.target.value)}
                  className="h-8 w-16 rounded border border-border bg-background px-2 text-sm"
                  required
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">Intensity</label>
                <select
                  value={formIntensity}
                  onChange={(e) => setFormIntensity(e.target.value as IntensityLevel | "")}
                  className="h-8 rounded border border-border bg-background px-2 text-sm"
                >
                  <option value="">—</option>
                  <option value="light">Light</option>
                  <option value="moderate">Moderate</option>
                  <option value="vigorous">Vigorous</option>
                </select>
              </div>
            </div>
            <input
              type="text"
              placeholder="Notes (optional)"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              className="w-full h-8 rounded border border-border bg-background px-2 text-sm"
            />
            {formErr && <p className="text-xs text-destructive">{formErr}</p>}
            <Button type="submit" size="sm" disabled={logMutation.isPending}>
              {logMutation.isPending ? "Saving..." : "Save"}
            </Button>
          </form>
        )}

        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">No workouts logged in the last 14 days.</p>
        ) : (
          <div className="divide-y divide-border/30">
            {logs.map((log) => (
              <ExerciseLogRow
                key={log.id}
                log={log}
                onDelete={(id) => deleteMutation.mutate({ id, companyId })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Biometrics ----

function BiometricRow({
  reading,
  onDelete,
}: {
  reading: BiometricReading;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const bpLabel =
    reading.systolicBp !== null && reading.diastolicBp !== null
      ? `${reading.systolicBp}/${reading.diastolicBp} mmHg`
      : null;

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium tabular-nums">{reading.measurementDate}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
          {reading.weightKg !== null && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Weight className="w-3 h-3" />
              {reading.weightKg.toFixed(1)} kg
            </span>
          )}
          {bpLabel && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Activity className="w-3 h-3" />
              {bpLabel}
            </span>
          )}
          {reading.restingHeartRate !== null && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Heart className="w-3 h-3" />
              {reading.restingHeartRate} bpm
            </span>
          )}
        </div>
        {reading.notes && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{reading.notes}</p>
        )}
      </div>
      <div className="shrink-0">
        {confirming ? (
          <div className="flex gap-1">
            <button
              className="text-[10px] text-destructive font-medium px-1.5 py-0.5 rounded border border-destructive/30 hover:bg-destructive/10 transition-colors"
              onClick={() => onDelete(reading.id)}
            >
              Delete
            </button>
            <button
              className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded border border-border hover:bg-muted transition-colors"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="text-muted-foreground hover:text-destructive transition-colors"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function BiometricsView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useBiometricsHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogBiometrics();
  const deleteMutation = useDeleteBiometricReading();

  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(today);
  const [formWeight, setFormWeight] = useState("");
  const [formSystolic, setFormSystolic] = useState("");
  const [formDiastolic, setFormDiastolic] = useState("");
  const [formHr, setFormHr] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const readings = data?.readings ?? [];

  function resetForm() {
    setFormDate(today);
    setFormWeight("");
    setFormSystolic("");
    setFormDiastolic("");
    setFormHr("");
    setFormNotes("");
    setFormError(null);
    setShowForm(false);
  }

  function handleSubmit() {
    setFormError(null);
    const weightKg = formWeight !== "" ? parseFloat(formWeight) : undefined;
    const systolicBp = formSystolic !== "" ? parseInt(formSystolic, 10) : undefined;
    const diastolicBp = formDiastolic !== "" ? parseInt(formDiastolic, 10) : undefined;
    const restingHeartRate = formHr !== "" ? parseInt(formHr, 10) : undefined;

    if (weightKg === undefined && systolicBp === undefined && restingHeartRate === undefined) {
      setFormError("Enter at least one measurement.");
      return;
    }
    if (weightKg !== undefined && (isNaN(weightKg) || weightKg <= 0)) {
      setFormError("Weight must be a positive number.");
      return;
    }
    if (systolicBp !== undefined && (isNaN(systolicBp) || systolicBp <= 0)) {
      setFormError("Systolic BP must be a positive number.");
      return;
    }
    if (diastolicBp !== undefined && (isNaN(diastolicBp) || diastolicBp <= 0)) {
      setFormError("Diastolic BP must be a positive number.");
      return;
    }
    if (restingHeartRate !== undefined && (isNaN(restingHeartRate) || restingHeartRate <= 0)) {
      setFormError("Heart rate must be a positive number.");
      return;
    }

    logMutation.mutate(
      {
        companyId,
        measurementDate: formDate,
        weightKg,
        systolicBp,
        diastolicBp,
        restingHeartRate,
        notes: formNotes.trim() || null,
      },
      { onSuccess: resetForm, onError: (e) => setFormError(e.message) },
    );
  }

  if (isLoading) return <PageSkeleton />;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="w-4 h-4" />
        {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Last 14 days</p>
        <Button size="sm" variant="outline" onClick={() => setShowForm((s) => !s)}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Log
        </Button>
      </div>

      {showForm && (
        <div className="rounded-md border border-border p-4 space-y-3 bg-muted/30">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Date
              </label>
              <input
                type="date"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formDate}
                max={today}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Weight (kg)
              </label>
              <input
                type="number"
                step="0.1"
                min="1"
                placeholder="e.g. 75.5"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formWeight}
                onChange={(e) => setFormWeight(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Systolic BP
              </label>
              <input
                type="number"
                min="1"
                placeholder="e.g. 120"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formSystolic}
                onChange={(e) => setFormSystolic(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Diastolic BP
              </label>
              <input
                type="number"
                min="1"
                placeholder="e.g. 80"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formDiastolic}
                onChange={(e) => setFormDiastolic(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Heart Rate (bpm)
              </label>
              <input
                type="number"
                min="1"
                placeholder="e.g. 62"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formHr}
                onChange={(e) => setFormHr(e.target.value)}
              />
            </div>
            <div className="space-y-1 col-span-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Notes
              </label>
              <input
                type="text"
                placeholder="Optional note"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={logMutation.isPending}
            >
              {logMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border border-border divide-y divide-border/30">
        {readings.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2 px-3">No readings in the last 14 days.</p>
        ) : (
          <div className="divide-y divide-border/30 px-3">
            {readings.map((r) => (
              <BiometricRow
                key={r.id}
                reading={r}
                onDelete={(id) => deleteMutation.mutate({ id, companyId })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Mood ----

const MOOD_EMOJI: Record<number, string> = {
  1: "😞", 2: "😟", 3: "😕", 4: "😐", 5: "🙂",
  6: "😊", 7: "😄", 8: "😁", 9: "🤩", 10: "🥳",
};

function MoodRow({ log, onDelete }: { log: MoodLog; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium tabular-nums">{log.logDate}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Smile className="w-3 h-3" />
            Mood {log.moodScore}/10 {MOOD_EMOJI[log.moodScore]}
          </span>
          {log.energyLevel !== null && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Zap className="w-3 h-3" />
              Energy {log.energyLevel}/10
            </span>
          )}
        </div>
        {log.notes && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{log.notes}</p>
        )}
      </div>
      <div className="shrink-0">
        {confirming ? (
          <div className="flex gap-1">
            <button
              className="text-[10px] text-destructive font-medium px-1.5 py-0.5 rounded border border-destructive/30 hover:bg-destructive/10 transition-colors"
              onClick={() => onDelete(log.id)}
            >
              Delete
            </button>
            <button
              className="text-[10px] text-muted-foreground px-1.5 py-0.5 rounded border border-border hover:bg-muted transition-colors"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="text-muted-foreground hover:text-destructive transition-colors"
            onClick={() => setConfirming(true)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function MoodView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useMoodHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogMood();
  const deleteMutation = useDeleteMoodLog();

  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(today);
  const [formMood, setFormMood] = useState("7");
  const [formEnergy, setFormEnergy] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const logs = data?.logs ?? [];

  function resetForm() {
    setFormDate(today);
    setFormMood("7");
    setFormEnergy("");
    setFormNotes("");
    setFormError(null);
    setShowForm(false);
  }

  function handleSubmit() {
    setFormError(null);
    const moodScore = parseInt(formMood, 10);
    if (isNaN(moodScore) || moodScore < 1 || moodScore > 10) {
      setFormError("Mood score must be between 1 and 10.");
      return;
    }
    let energyLevel: number | undefined;
    if (formEnergy !== "") {
      energyLevel = parseInt(formEnergy, 10);
      if (isNaN(energyLevel) || energyLevel < 1 || energyLevel > 10) {
        setFormError("Energy level must be between 1 and 10.");
        return;
      }
    }

    logMutation.mutate(
      {
        companyId,
        logDate: formDate,
        moodScore,
        energyLevel: energyLevel ?? null,
        notes: formNotes.trim() || null,
      },
      { onSuccess: resetForm, onError: (e) => setFormError(e.message) },
    );
  }

  if (isLoading) return <PageSkeleton />;
  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="w-4 h-4" />
        {error.message}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Last 14 days</p>
        <Button size="sm" variant="outline" onClick={() => setShowForm((s) => !s)}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Log
        </Button>
      </div>

      {showForm && (
        <div className="rounded-md border border-border p-4 space-y-3 bg-muted/30">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1 col-span-2 sm:col-span-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Date
              </label>
              <input
                type="date"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formDate}
                max={today}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Mood Score (1–10)
              </label>
              <input
                type="number"
                min="1"
                max="10"
                placeholder="e.g. 7"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formMood}
                onChange={(e) => setFormMood(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Energy Level (1–10)
              </label>
              <input
                type="number"
                min="1"
                max="10"
                placeholder="Optional"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formEnergy}
                onChange={(e) => setFormEnergy(e.target.value)}
              />
            </div>
            <div className="space-y-1 col-span-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Notes
              </label>
              <input
                type="text"
                placeholder="Optional note"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSubmit} disabled={logMutation.isPending}>
              {logMutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={resetForm}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-md border border-border divide-y divide-border/30">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2 px-3">No mood logs in the last 14 days.</p>
        ) : (
          <div className="divide-y divide-border/30 px-3">
            {logs.map((l) => (
              <MoodRow
                key={l.id}
                log={l}
                onDelete={(id) => deleteMutation.mutate({ id, companyId })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Page ----

export function Health() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [view, setView] = useState<"score" | "locations" | "sleep" | "exercise" | "biometrics" | "mood">("score");

  useEffect(() => {
    setBreadcrumbs([{ label: "Health" }]);
  }, [setBreadcrumbs]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Activity} message="Select a company to view health data." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-0.5 rounded-md bg-muted w-fit">
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "score" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("score")}
        >
          Environmental Score
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "locations" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("locations")}
        >
          Locations
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "sleep" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("sleep")}
        >
          Sleep
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "exercise" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("exercise")}
        >
          Exercise
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "biometrics" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("biometrics")}
        >
          Biometrics
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "mood" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("mood")}
        >
          Mood
        </button>
      </div>

      {view === "score" ? (
        <ScoreView companyId={selectedCompanyId} />
      ) : view === "locations" ? (
        <LocationsView companyId={selectedCompanyId} />
      ) : view === "sleep" ? (
        <SleepView companyId={selectedCompanyId} />
      ) : view === "exercise" ? (
        <ExerciseView companyId={selectedCompanyId} />
      ) : view === "biometrics" ? (
        <BiometricsView companyId={selectedCompanyId} />
      ) : (
        <MoodView companyId={selectedCompanyId} />
      )}
    </div>
  );
}
