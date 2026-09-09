import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Activity, AlertCircle, BookOpen, ChevronDown, ChevronUp, Dumbbell, Heart, Leaf, MapPin, Moon, Pencil, Plus, Smile, Sun, Thermometer, Trash2, Weight, Wind, Zap } from "lucide-react";
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
import {
  useNutritionHistory,
  useLogNutrition,
  useDeleteNutritionLog,
  type NutritionLog,
} from "../hooks/useNutrition";
import {
  useSymptomHistory,
  useLogSymptom,
  useDeleteSymptomLog,
  VALID_SYMPTOMS,
  type SymptomLog,
  type SymptomType,
} from "../hooks/useSymptoms";
import {
  useMedicationHistory,
  useLogMedication,
  useDeleteMedicationLog,
  type MedicationLog,
} from "../hooks/useMedications";
import {
  useLabResults,
  useLogLabResult,
  useDeleteLabResult,
  LAB_MARKER_PRESETS,
  type LabResult,
} from "../hooks/useLabResults";
import {
  useHealthGoals,
  useUpsertHealthGoal,
  useDeleteHealthGoal,
  type HealthGoal,
} from "../hooks/useHealthGoals";
import {
  useJournalHistory,
  useCreateJournalEntry,
  useDeleteJournalEntry,
  type JournalEntry,
} from "../hooks/useJournal";
import {
  useMeditationHistory,
  useLogMeditation,
  useDeleteMeditationLog,
  MEDITATION_TECHNIQUES,
} from "../hooks/useMeditation";
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

// ---- Dashboard ----

interface GoalMetricRow {
  goalType: string;
  label: string;
  target: number;
  unit: string;
  actual: number | null;
}

function GoalProgressBar({ row }: { row: GoalMetricRow }) {
  const pct = row.actual != null && row.target > 0 ? Math.min(100, Math.round((row.actual / row.target) * 100)) : 0;
  const logged = row.actual != null;
  const met = logged && row.actual! >= row.target;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{row.label}</span>
        <span className={cn("tabular-nums", met ? "text-green-600" : logged ? "text-foreground" : "text-muted-foreground")}>
          {logged ? `${row.actual} / ${row.target} ${row.unit}` : `— / ${row.target} ${row.unit}`}
        </span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", met ? "bg-green-500" : logged ? "bg-blue-500" : "bg-muted-foreground/20")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function DashboardView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: goalsData, isLoading: goalsLoading } = useHealthGoals(companyId);
  const { data: sleepData } = useSleepHistory(companyId, today, today);
  const { data: exerciseData } = useExerciseHistory(companyId, today, today);
  const { data: meditationData } = useMeditationHistory(companyId, today, today);
  const { data: nutritionData } = useNutritionHistory(companyId, today, today);
  const { data: moodData } = useMoodHistory(companyId, today, today);
  const { data: biometricsData } = useBiometricsHistory(companyId, today, today);

  if (goalsLoading) return <PageSkeleton variant="dashboard" />;

  const goals = goalsData ?? [];

  // Compute today's actual values from the tracker data
  function actualFor(goalType: string): number | null {
    switch (goalType) {
      case "water_ml":
        return nutritionData?.logs[0]?.waterMl ?? null;
      case "calories":
        return nutritionData?.logs[0]?.calories ?? null;
      case "protein_g":
        return nutritionData?.logs[0]?.proteinG ?? null;
      case "sleep_minutes":
        return sleepData?.records[0]?.durationMinutes ?? null;
      case "exercise_minutes": {
        const sessions = exerciseData?.logs.filter((l) => l.exerciseDate === today) ?? [];
        if (sessions.length === 0) return null;
        return sessions.reduce((sum, l) => sum + l.durationMinutes, 0);
      }
      case "meditation_minutes": {
        const sessions = meditationData?.logs.filter((l) => l.sessionDate === today) ?? [];
        if (sessions.length === 0) return null;
        return sessions.reduce((sum, l) => sum + l.durationMinutes, 0);
      }
      case "mood_score":
        return moodData?.logs[0]?.moodScore ?? null;
      case "weight_kg":
        return biometricsData?.readings[0]?.weightKg ?? null;
      default:
        return null;
    }
  }

  const rows: GoalMetricRow[] = goals.map((g) => ({
    goalType: g.goalType,
    label: g.label,
    target: g.targetValue,
    unit: g.unit,
    actual: actualFor(g.goalType),
  }));

  const logged = rows.filter((r) => r.actual != null).length;
  const met = rows.filter((r) => r.actual != null && r.actual >= r.target).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Today's Health Dashboard</h2>
          <p className="text-xs text-muted-foreground">
            {new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </p>
        </div>
        {rows.length > 0 && (
          <div className="text-right">
            <p className="text-lg font-bold tabular-nums">{met}/{rows.length}</p>
            <p className="text-xs text-muted-foreground">goals met</p>
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Zap}
          message="No health goals set yet. Add goals in the Goals tab to track your daily progress here."
        />
      ) : (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          {rows.map((row) => (
            <GoalProgressBar key={row.goalType} row={row} />
          ))}
          <p className="text-xs text-muted-foreground pt-1 border-t border-border">
            {logged} of {rows.length} metrics logged today
          </p>
        </div>
      )}

      {/* Quick stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {sleepData?.records[0] && (
          <div className="rounded-lg border border-border bg-card p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Moon className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Sleep</span>
            </div>
            <p className="text-xl font-semibold tabular-nums">{sleepData.records[0].durationMinutes}m</p>
          </div>
        )}
        {exerciseData && exerciseData.logs.filter((l) => l.exerciseDate === today).length > 0 && (
          <div className="rounded-lg border border-border bg-card p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Dumbbell className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Exercise</span>
            </div>
            <p className="text-xl font-semibold tabular-nums">
              {exerciseData.logs.filter((l) => l.exerciseDate === today).reduce((s, l) => s + l.durationMinutes, 0)}m
            </p>
          </div>
        )}
        {nutritionData?.logs[0] && (
          <div className="rounded-lg border border-border bg-card p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Zap className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Water</span>
            </div>
            <p className="text-xl font-semibold tabular-nums">{nutritionData.logs[0].waterMl}ml</p>
          </div>
        )}
        {moodData?.logs[0] && (
          <div className="rounded-lg border border-border bg-card p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Smile className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Mood</span>
            </div>
            <p className="text-xl font-semibold tabular-nums">{moodData.logs[0].moodScore}/10</p>
          </div>
        )}
        {biometricsData?.readings[0]?.weightKg && (
          <div className="rounded-lg border border-border bg-card p-3 space-y-0.5">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Weight className="h-3.5 w-3.5" />
              <span className="text-xs font-medium uppercase tracking-wide">Weight</span>
            </div>
            <p className="text-xl font-semibold tabular-nums">{biometricsData.readings[0].weightKg}kg</p>
          </div>
        )}
      </div>
    </div>
  );
}

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

// ---- Nutrition ----

function NutritionRow({ log, onDelete }: { log: NutritionLog; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium tabular-nums">{log.logDate}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Wind className="w-3 h-3" />
            {log.waterMl} ml water
          </span>
          {log.calories !== null && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {log.calories} kcal
            </span>
          )}
          {log.proteinG !== null && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Leaf className="w-3 h-3" />
              {log.proteinG}g protein
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

function NutritionView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useNutritionHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogNutrition();
  const deleteMutation = useDeleteNutritionLog();

  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(today);
  const [formWater, setFormWater] = useState("2000");
  const [formCalories, setFormCalories] = useState("");
  const [formProtein, setFormProtein] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const logs = data?.logs ?? [];

  function resetForm() {
    setFormDate(today);
    setFormWater("2000");
    setFormCalories("");
    setFormProtein("");
    setFormNotes("");
    setFormError(null);
    setShowForm(false);
  }

  function handleSubmit() {
    setFormError(null);
    const waterMl = parseInt(formWater, 10);
    if (isNaN(waterMl) || waterMl < 0) {
      setFormError("Water must be a non-negative number (ml).");
      return;
    }

    let calories: number | null = null;
    if (formCalories !== "") {
      calories = parseInt(formCalories, 10);
      if (isNaN(calories) || calories < 0) {
        setFormError("Calories must be a non-negative number.");
        return;
      }
    }

    let proteinG: number | null = null;
    if (formProtein !== "") {
      proteinG = parseInt(formProtein, 10);
      if (isNaN(proteinG) || proteinG < 0) {
        setFormError("Protein must be a non-negative number.");
        return;
      }
    }

    logMutation.mutate(
      {
        companyId,
        logDate: formDate,
        waterMl,
        calories,
        proteinG,
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
                Water (ml)
              </label>
              <input
                type="number"
                min="0"
                placeholder="e.g. 2000"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formWater}
                onChange={(e) => setFormWater(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Calories (kcal)
              </label>
              <input
                type="number"
                min="0"
                placeholder="Optional"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formCalories}
                onChange={(e) => setFormCalories(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Protein (g)
              </label>
              <input
                type="number"
                min="0"
                placeholder="Optional"
                className="w-full text-sm border border-border rounded px-2 py-1 bg-background"
                value={formProtein}
                onChange={(e) => setFormProtein(e.target.value)}
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
          <p className="text-sm text-muted-foreground py-2 px-3">No nutrition logs in the last 14 days.</p>
        ) : (
          <div className="divide-y divide-border/30 px-3">
            {logs.map((l) => (
              <NutritionRow
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

// ---- Symptoms ----

const SYMPTOM_LABEL: Record<SymptomType, string> = {
  headache: "Headache",
  fatigue: "Fatigue",
  nausea: "Nausea",
  sore_throat: "Sore Throat",
  runny_nose: "Runny Nose",
  cough: "Cough",
  chest_pain: "Chest Pain",
  shortness_of_breath: "Shortness of Breath",
  dizziness: "Dizziness",
  body_aches: "Body Aches",
  fever: "Fever",
  chills: "Chills",
  stomach_pain: "Stomach Pain",
  back_pain: "Back Pain",
  anxiety: "Anxiety",
  insomnia: "Insomnia",
  other: "Other",
};

const SEVERITY_LABEL: Record<number, string> = {
  1: "Mild",
  2: "Slight",
  3: "Moderate",
  4: "Severe",
  5: "Very Severe",
};

function SymptomRow({ log, onDelete }: { log: SymptomLog; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{log.symptomDate}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <Heart className="w-3 h-3" />
            {SYMPTOM_LABEL[log.symptom] ?? log.symptom}
          </span>
          {log.severity !== null && (
            <span className="text-xs text-muted-foreground">
              {SEVERITY_LABEL[log.severity] ?? `Severity ${log.severity}`}
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

function SymptomsView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useSymptomHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogSymptom();
  const deleteMutation = useDeleteSymptomLog();

  const [formDate, setFormDate] = useState(today);
  const [formSymptom, setFormSymptom] = useState<SymptomType>("headache");
  const [formSeverity, setFormSeverity] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function resetForm() {
    setFormDate(today);
    setFormSymptom("headache");
    setFormSeverity("");
    setFormNotes("");
    setFormError(null);
  }

  async function handleSubmit() {
    setFormError(null);
    const severity = formSeverity ? parseInt(formSeverity, 10) : undefined;
    try {
      await logMutation.mutateAsync({
        companyId,
        symptomDate: formDate,
        symptom: formSymptom,
        severity: severity ?? null,
        notes: formNotes.trim() || null,
      });
      resetForm();
      setShowForm(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to log symptom");
    }
  }

  if (isLoading) return <PageSkeleton />;
  if (error) return <EmptyState icon={Heart} message={`Failed to load symptoms: ${error.message}`} />;

  const logs = data?.logs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Last 14 days</p>
        <Button size="sm" variant="outline" onClick={() => { resetForm(); setShowForm(true); }}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          Log Symptom
        </Button>
      </div>

      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { resetForm(); setShowForm(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log Symptom</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Date</label>
              <input
                type="date"
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formDate}
                max={today}
                onChange={(e) => setFormDate(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Symptom</label>
              <select
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formSymptom}
                onChange={(e) => setFormSymptom(e.target.value as SymptomType)}
              >
                {VALID_SYMPTOMS.map((s) => (
                  <option key={s} value={s}>{SYMPTOM_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Severity (optional)</label>
              <select
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={formSeverity}
                onChange={(e) => setFormSeverity(e.target.value)}
              >
                <option value="">—</option>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>{n} — {SEVERITY_LABEL[n]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Notes (optional)</label>
              <textarea
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none"
                rows={2}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { resetForm(); setShowForm(false); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={logMutation.isPending}>
              {logMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {logs.length === 0 ? (
        <EmptyState icon={Heart} message="No symptoms logged in the last 14 days." />
      ) : (
        <div className="divide-y divide-border rounded-lg border bg-card px-4">
          {logs.map((l) => (
            <SymptomRow
              key={l.id}
              log={l}
              onDelete={(id) => deleteMutation.mutate({ id, companyId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Medications ----

function MedicationRow({ log, onDelete }: { log: MedicationLog; onDelete: (id: string) => void }) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-start gap-3 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{log.medicationDate}</p>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
          <span className="text-xs text-muted-foreground font-medium">{log.medicationName}</span>
          {log.dosage && (
            <span className="text-xs text-muted-foreground">{log.dosage}</span>
          )}
          <span className={cn("text-xs", log.taken ? "text-green-600" : "text-muted-foreground")}>
            {log.taken ? "Taken" : "Skipped"}
          </span>
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

function MedicationsView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useMedicationHistory(companyId, fourteenDaysAgo, today);
  const logMutation = useLogMedication();
  const deleteMutation = useDeleteMedicationLog();

  const [formDate, setFormDate] = useState(today);
  const [formName, setFormName] = useState("");
  const [formDosage, setFormDosage] = useState("");
  const [formTaken, setFormTaken] = useState(true);
  const [formNotes, setFormNotes] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function resetForm() {
    setFormDate(today);
    setFormName("");
    setFormDosage("");
    setFormTaken(true);
    setFormNotes("");
    setFormError(null);
  }

  async function handleSubmit() {
    setFormError(null);
    if (!formName.trim()) {
      setFormError("Medication name is required");
      return;
    }
    try {
      await logMutation.mutateAsync({
        companyId,
        medicationDate: formDate,
        medicationName: formName.trim(),
        dosage: formDosage.trim() || null,
        taken: formTaken,
        notes: formNotes.trim() || null,
      });
      resetForm();
      setShowForm(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to log medication");
    }
  }

  if (isLoading) return <PageSkeleton />;
  if (error) return <EmptyState icon={Activity} message="Failed to load medication logs." />;

  const logs = data?.logs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Medications — last 14 days</h2>
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Log Medication
        </Button>
      </div>

      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { resetForm(); setShowForm(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log Medication</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Date</label>
              <input
                type="date"
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                max={today}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Medication Name *</label>
              <input
                type="text"
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                placeholder="e.g. Ibuprofen"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Dosage</label>
              <input
                type="text"
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                placeholder="e.g. 200mg, 1 tablet"
                value={formDosage}
                onChange={(e) => setFormDosage(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="med-taken"
                type="checkbox"
                checked={formTaken}
                onChange={(e) => setFormTaken(e.target.checked)}
              />
              <label htmlFor="med-taken" className="text-sm">Taken</label>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Notes</label>
              <textarea
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background resize-none"
                rows={2}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { resetForm(); setShowForm(false); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={logMutation.isPending}>
              {logMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {logs.length === 0 ? (
        <EmptyState icon={Activity} message="No medications logged in the last 14 days." />
      ) : (
        <div className="divide-y divide-border rounded-lg border bg-card px-4">
          {logs.map((l) => (
            <MedicationRow
              key={l.id}
              log={l}
              onDelete={(id) => deleteMutation.mutate({ id, companyId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Lab Results ----

function inRange(result: LabResult): boolean | null {
  const val = parseFloat(result.value);
  const min = result.optimalMin !== null ? parseFloat(result.optimalMin) : null;
  const max = result.optimalMax !== null ? parseFloat(result.optimalMax) : null;
  if (min === null && max === null) return null;
  if (min !== null && val < min) return false;
  if (max !== null && val > max) return false;
  return true;
}

function LabResultRow({ result, onDelete }: { result: LabResult; onDelete: (id: string) => void }) {
  const status = inRange(result);
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{result.markerName}</span>
          {status === true && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400 shrink-0">
              In range
            </span>
          )}
          {status === false && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 shrink-0">
              Out of range
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {result.measuredDate}
          {result.source && ` · ${result.source}`}
          {result.optimalMin !== null && result.optimalMax !== null && (
            <> · optimal {result.optimalMin}–{result.optimalMax} {result.unit}</>
          )}
          {result.optimalMin !== null && result.optimalMax === null && (
            <> · optimal ≥ {result.optimalMin} {result.unit}</>
          )}
          {result.optimalMin === null && result.optimalMax !== null && (
            <> · optimal ≤ {result.optimalMax} {result.unit}</>
          )}
        </p>
        {result.notes && <p className="text-xs text-muted-foreground mt-0.5 italic">{result.notes}</p>}
      </div>
      <span className="text-sm font-medium tabular-nums shrink-0">
        {result.value} <span className="text-muted-foreground font-normal">{result.unit}</span>
      </span>
      <button
        className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
        onClick={() => onDelete(result.id)}
        aria-label="Delete lab result"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function LabResultsView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const oneYearAgo = new Date(Date.now() - 364 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useLabResults(companyId, oneYearAgo, today);
  const logMutation = useLogLabResult();
  const deleteMutation = useDeleteLabResult();

  const [showForm, setShowForm] = useState(false);
  const [formDate, setFormDate] = useState(today);
  const [formMarker, setFormMarker] = useState("");
  const [formCustomMarker, setFormCustomMarker] = useState("");
  const [formValue, setFormValue] = useState("");
  const [formUnit, setFormUnit] = useState("");
  const [formOptimalMin, setFormOptimalMin] = useState("");
  const [formOptimalMax, setFormOptimalMax] = useState("");
  const [formSource, setFormSource] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const isCustomMarker = formMarker === "__custom__";
  const effectiveMarkerName = isCustomMarker ? formCustomMarker.trim() : formMarker;

  function applyPreset(name: string) {
    const preset = LAB_MARKER_PRESETS.find((p) => p.name === name);
    if (preset) {
      setFormUnit(preset.unit);
      setFormOptimalMin(preset.optimalMin !== null ? String(preset.optimalMin) : "");
      setFormOptimalMax(preset.optimalMax !== null ? String(preset.optimalMax) : "");
    } else {
      setFormUnit("");
      setFormOptimalMin("");
      setFormOptimalMax("");
    }
  }

  function handleMarkerChange(name: string) {
    setFormMarker(name);
    if (name !== "__custom__") applyPreset(name);
  }

  function resetForm() {
    setFormDate(today);
    setFormMarker("");
    setFormCustomMarker("");
    setFormValue("");
    setFormUnit("");
    setFormOptimalMin("");
    setFormOptimalMax("");
    setFormSource("");
    setFormNotes("");
    setFormError(null);
  }

  async function handleSubmit() {
    setFormError(null);
    if (!effectiveMarkerName) {
      setFormError("Marker name is required");
      return;
    }
    const numValue = parseFloat(formValue);
    if (!formValue || isNaN(numValue)) {
      setFormError("Value must be a number");
      return;
    }
    if (!formUnit.trim()) {
      setFormError("Unit is required");
      return;
    }
    const preset = LAB_MARKER_PRESETS.find((p) => p.name === formMarker);
    try {
      await logMutation.mutateAsync({
        companyId,
        measuredDate: formDate,
        markerName: effectiveMarkerName,
        value: numValue,
        unit: formUnit.trim(),
        loincCode: preset?.loincCode ?? null,
        optimalMin: formOptimalMin ? parseFloat(formOptimalMin) : null,
        optimalMax: formOptimalMax ? parseFloat(formOptimalMax) : null,
        source: formSource.trim() || null,
        notes: formNotes.trim() || null,
      });
      resetForm();
      setShowForm(false);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to log lab result");
    }
  }

  if (isLoading) return <PageSkeleton />;
  if (error) return <EmptyState icon={Activity} message="Failed to load lab results." />;

  const results = data?.results ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Lab Results — last 12 months</h2>
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="w-3.5 h-3.5 mr-1" /> Log Result
        </Button>
      </div>

      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { resetForm(); setShowForm(false); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Log Lab Result</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Date *</label>
              <input
                type="date"
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                max={today}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Biomarker *</label>
              <select
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                value={formMarker}
                onChange={(e) => handleMarkerChange(e.target.value)}
              >
                <option value="">Select a marker…</option>
                {LAB_MARKER_PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
                <option value="__custom__">Custom marker…</option>
              </select>
            </div>
            {isCustomMarker && (
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Custom Marker Name *</label>
                <input
                  type="text"
                  className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                  placeholder="e.g. Total Cholesterol"
                  value={formCustomMarker}
                  onChange={(e) => setFormCustomMarker(e.target.value)}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Value *</label>
                <input
                  type="number"
                  step="any"
                  className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                  placeholder="e.g. 5.2"
                  value={formValue}
                  onChange={(e) => setFormValue(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Unit *</label>
                <input
                  type="text"
                  className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                  placeholder="e.g. %"
                  value={formUnit}
                  onChange={(e) => setFormUnit(e.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Optimal Min</label>
                <input
                  type="number"
                  step="any"
                  className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                  placeholder="optional"
                  value={formOptimalMin}
                  onChange={(e) => setFormOptimalMin(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Optimal Max</label>
                <input
                  type="number"
                  step="any"
                  className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                  placeholder="optional"
                  value={formOptimalMax}
                  onChange={(e) => setFormOptimalMax(e.target.value)}
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Lab / Source</label>
              <input
                type="text"
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background"
                placeholder="e.g. Quest, LabCorp"
                value={formSource}
                onChange={(e) => setFormSource(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Notes</label>
              <textarea
                className="w-full border border-border rounded px-2 py-1 text-sm bg-background resize-none"
                rows={2}
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
              />
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { resetForm(); setShowForm(false); }}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={logMutation.isPending}>
              {logMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {results.length === 0 ? (
        <EmptyState icon={Activity} message="No lab results logged in the last 12 months." />
      ) : (
        <div className="divide-y divide-border rounded-lg border bg-card px-4">
          {results.map((r) => (
            <LabResultRow
              key={r.id}
              result={r}
              onDelete={(id) => deleteMutation.mutate({ id, companyId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Goals ----

const GOAL_TYPE_OPTIONS = [
  { value: "water_ml",             label: "Daily Water",      unit: "ml" },
  { value: "sleep_minutes",        label: "Sleep",            unit: "min" },
  { value: "exercise_minutes",     label: "Exercise",         unit: "min" },
  { value: "meditation_minutes",   label: "Meditation",       unit: "min" },
  { value: "calories",             label: "Calories",         unit: "kcal" },
  { value: "protein_g",            label: "Protein",          unit: "g" },
  { value: "steps",                label: "Steps",            unit: "steps" },
  { value: "weight_kg",            label: "Weight",           unit: "kg" },
  { value: "mood_score",           label: "Mood Score",       unit: "/ 10" },
];

function GoalCard({ goal, onDelete }: { goal: HealthGoal; onDelete: () => void }) {
  const opt = GOAL_TYPE_OPTIONS.find((o) => o.value === goal.goalType);
  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{goal.label}</p>
        <p className="text-xs text-muted-foreground">
          Target: <span className="font-semibold text-foreground">{goal.targetValue}</span>{" "}
          {opt?.unit ?? goal.unit}
        </p>
      </div>
      <button
        onClick={onDelete}
        className="ml-3 shrink-0 text-muted-foreground hover:text-destructive transition-colors"
        title="Remove goal"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

function GoalsView({ companyId }: { companyId: string }) {
  const { data: goals = [], isLoading, error } = useHealthGoals(companyId);
  const upsertMutation = useUpsertHealthGoal();
  const deleteMutation = useDeleteHealthGoal();

  const [showForm, setShowForm] = useState(false);
  const [formType, setFormType] = useState(GOAL_TYPE_OPTIONS[0].value);
  const [formTarget, setFormTarget] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function resetForm() {
    setFormType(GOAL_TYPE_OPTIONS[0].value);
    setFormTarget("");
    setFormNotes("");
    setFormError(null);
  }

  function handleSubmit() {
    setFormError(null);
    const tv = parseInt(formTarget, 10);
    if (!formTarget || isNaN(tv) || tv <= 0) {
      setFormError("Target value must be a positive number.");
      return;
    }
    const opt = GOAL_TYPE_OPTIONS.find((o) => o.value === formType)!;
    upsertMutation.mutate(
      {
        companyId,
        goalType: formType,
        targetValue: tv,
        unit: opt.unit,
        label: opt.label,
        notes: formNotes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          resetForm();
        },
        onError: () => setFormError("Failed to save goal. Please try again."),
      },
    );
  }

  if (isLoading) return <PageSkeleton variant="dashboard" />;

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Failed to load health goals.</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Health Goals</h2>
          <p className="text-xs text-muted-foreground">Set daily targets for tracked health metrics</p>
        </div>
        <Button size="sm" onClick={() => { resetForm(); setShowForm(true); }}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Set Goal
        </Button>
      </div>

      <Dialog open={showForm} onOpenChange={(open) => { if (!open) { setShowForm(false); resetForm(); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Set Health Goal</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs font-medium">Goal Type</label>
              <select
                value={formType}
                onChange={(e) => setFormType(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              >
                {GOAL_TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">
                Target ({GOAL_TYPE_OPTIONS.find((o) => o.value === formType)?.unit})
              </label>
              <input
                type="number"
                min={1}
                value={formTarget}
                onChange={(e) => setFormTarget(e.target.value)}
                placeholder="e.g. 2500"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Notes (optional)</label>
              <input
                type="text"
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="e.g. pre-workout only"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            {formError && <p className="text-xs text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setShowForm(false); resetForm(); }}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={upsertMutation.isPending}>
              {upsertMutation.isPending ? "Saving…" : "Save Goal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {goals.length === 0 ? (
        <EmptyState icon={Zap} message="No goals set yet. Add a goal to track your daily targets." />
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {goals.map((g) => (
            <GoalCard
              key={g.id}
              goal={g}
              onDelete={() => deleteMutation.mutate({ id: g.id, companyId })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Meditation ----

function MeditationView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useMeditationHistory(companyId, thirtyDaysAgo, today);
  const logMutation = useLogMeditation();
  const deleteMutation = useDeleteMeditationLog();

  const [showForm, setShowForm] = useState(false);
  const [sessionDate, setSessionDate] = useState(today);
  const [durationMinutes, setDurationMinutes] = useState("");
  const [technique, setTechnique] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function handleLog() {
    const dur = parseInt(durationMinutes, 10);
    if (!durationMinutes || isNaN(dur) || dur < 1) {
      setFormError("Duration must be at least 1 minute.");
      return;
    }
    setFormError(null);
    logMutation.mutate(
      {
        companyId,
        sessionDate,
        durationMinutes: dur,
        technique: technique || null,
        notes: notes.trim() || null,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          setDurationMinutes("");
          setTechnique("");
          setNotes("");
        },
        onError: (e) => setFormError(e instanceof Error ? e.message : "Failed to log session."),
      },
    );
  }

  const logs = data?.logs ?? [];

  // Group logs by date for summary display
  const byDate = new Map<string, typeof logs>();
  for (const l of logs) {
    if (!byDate.has(l.sessionDate)) byDate.set(l.sessionDate, []);
    byDate.get(l.sessionDate)!.push(l);
  }
  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a));

  const totalMinutes = logs.reduce((sum, l) => sum + l.durationMinutes, 0);
  const totalSessions = logs.length;

  if (isLoading) return <PageSkeleton variant="dashboard" />;
  if (error)
    return <p className="text-sm text-destructive p-4">{error instanceof Error ? error.message : "Error"}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Meditation — Last 30 Days</h2>
          {totalSessions > 0 && (
            <p className="text-xs text-muted-foreground">
              {totalSessions} session{totalSessions !== 1 ? "s" : ""} · {totalMinutes} min total
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          + Log Session
        </Button>
      </div>

      {showForm && (
        <Dialog open onOpenChange={(o) => !o && setShowForm(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Log Meditation Session</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Date</label>
                  <input
                    type="date"
                    value={sessionDate}
                    onChange={(e) => setSessionDate(e.target.value)}
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Duration (min) *</label>
                  <input
                    type="number"
                    min={1}
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(e.target.value)}
                    placeholder="e.g. 15"
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Technique</label>
                <select
                  value={technique}
                  onChange={(e) => setTechnique(e.target.value)}
                  className="w-full border rounded px-2 py-1 text-sm"
                >
                  <option value="">— optional —</option>
                  {MEDITATION_TECHNIQUES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Optional notes..."
                  className="w-full border rounded px-2 py-1 text-sm resize-none"
                />
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleLog} disabled={logMutation.isPending}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {logs.length === 0 ? (
        <EmptyState icon={Leaf} message="No meditation sessions in the last 30 days." />
      ) : (
        <div className="space-y-3">
          {dates.map((date) => {
            const dayLogs = byDate.get(date)!;
            const dayTotal = dayLogs.reduce((sum, l) => sum + l.durationMinutes, 0);
            return (
              <div key={date} className="border rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-foreground">{date}</p>
                  <p className="text-xs text-muted-foreground">{dayTotal} min total</p>
                </div>
                <div className="space-y-1">
                  {dayLogs.map((l) => (
                    <div key={l.id} className="flex items-center justify-between group">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-foreground">{l.durationMinutes} min</span>
                        {l.technique && (
                          <span className="text-xs text-muted-foreground capitalize">{l.technique.replace("_", " ")}</span>
                        )}
                        {l.notes && (
                          <span className="text-xs text-muted-foreground truncate max-w-[120px]">{l.notes}</span>
                        )}
                      </div>
                      <button
                        onClick={() => deleteMutation.mutate({ id: l.id, companyId })}
                        disabled={deleteMutation.isPending}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-colors"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---- Journal ----

function JournalView({ companyId }: { companyId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);

  const { data, isLoading, error } = useJournalHistory(companyId, thirtyDaysAgo, today);
  const createMutation = useCreateJournalEntry();
  const deleteMutation = useDeleteJournalEntry();

  const [showForm, setShowForm] = useState(false);
  const [entryDate, setEntryDate] = useState(today);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [moodScore, setMoodScore] = useState("");
  const [tags, setTags] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  function handleCreate() {
    if (!body.trim()) {
      setFormError("Entry body is required.");
      return;
    }
    const moodNum = moodScore ? parseInt(moodScore, 10) : undefined;
    if (moodScore && (isNaN(moodNum!) || moodNum! < 1 || moodNum! > 10)) {
      setFormError("Mood score must be between 1 and 10.");
      return;
    }
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setFormError(null);
    createMutation.mutate(
      {
        companyId,
        entryDate,
        body: body.trim(),
        title: title.trim() || null,
        moodScore: moodNum ?? null,
        tags: tagList,
      },
      {
        onSuccess: () => {
          setShowForm(false);
          setTitle("");
          setBody("");
          setMoodScore("");
          setTags("");
        },
        onError: (e) => setFormError(e instanceof Error ? e.message : "Failed to save."),
      },
    );
  }

  const entries: JournalEntry[] = data?.entries ?? [];

  if (isLoading) return <PageSkeleton variant="dashboard" />;
  if (error)
    return <p className="text-sm text-destructive p-4">{error instanceof Error ? error.message : "Error"}</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Journal — Last 30 Days</h2>
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          + New Entry
        </Button>
      </div>

      {showForm && (
        <Dialog open onOpenChange={(o) => !o && setShowForm(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Journal Entry</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Date</label>
                <input
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                  className="w-full border rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Title (optional)</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="What's on your mind?"
                  className="w-full border rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Entry *</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  placeholder="Write your thoughts..."
                  className="w-full border rounded px-2 py-1 text-sm resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Mood (1–10)</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={moodScore}
                    onChange={(e) => setMoodScore(e.target.value)}
                    placeholder="Optional"
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="gratitude, goals"
                    className="w-full border rounded px-2 py-1 text-sm"
                  />
                </div>
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={createMutation.isPending}>
                Save
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {entries.length === 0 ? (
        <EmptyState icon={BookOpen} message="No journal entries in the last 30 days. Start writing!" />
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="border rounded-lg p-4 space-y-2 group relative">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs text-muted-foreground">{entry.entryDate}</p>
                  {entry.title && <p className="text-sm font-medium text-foreground">{entry.title}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {entry.moodScore !== null && (
                    <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-0.5">
                      Mood {entry.moodScore}/10
                    </span>
                  )}
                  <button
                    onClick={() => deleteMutation.mutate({ id: entry.id, companyId })}
                    disabled={deleteMutation.isPending}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-colors"
                    title="Delete entry"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap">{entry.body}</p>
              {entry.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {entry.tags.map((tag) => (
                    <span key={tag} className="text-xs bg-muted text-muted-foreground rounded px-2 py-0.5">
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Page ----

export function Health() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pathname } = useLocation();
  const [view, setView] = useState<"dashboard" | "score" | "locations" | "sleep" | "exercise" | "meditation" | "biometrics" | "mood" | "nutrition" | "symptoms" | "medications" | "lab-results" | "goals" | "journal">(
    pathname.includes("environmental-score") ? "score" : "dashboard"
  );

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
            view === "dashboard" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("dashboard")}
        >
          Dashboard
        </button>
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
            view === "meditation" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("meditation")}
        >
          Meditation
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
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "nutrition" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("nutrition")}
        >
          Nutrition
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "symptoms" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("symptoms")}
        >
          Symptoms
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "medications" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("medications")}
        >
          Medications
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "lab-results" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("lab-results")}
        >
          Lab Results
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "goals" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("goals")}
        >
          Goals
        </button>
        <button
          className={cn(
            "px-3 py-1 text-xs font-medium rounded transition-colors",
            view === "journal" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => setView("journal")}
        >
          Journal
        </button>
      </div>

      {view === "dashboard" ? (
        <DashboardView companyId={selectedCompanyId} />
      ) : view === "score" ? (
        <ScoreView companyId={selectedCompanyId} />
      ) : view === "locations" ? (
        <LocationsView companyId={selectedCompanyId} />
      ) : view === "sleep" ? (
        <SleepView companyId={selectedCompanyId} />
      ) : view === "exercise" ? (
        <ExerciseView companyId={selectedCompanyId} />
      ) : view === "meditation" ? (
        <MeditationView companyId={selectedCompanyId} />
      ) : view === "biometrics" ? (
        <BiometricsView companyId={selectedCompanyId} />
      ) : view === "mood" ? (
        <MoodView companyId={selectedCompanyId} />
      ) : view === "nutrition" ? (
        <NutritionView companyId={selectedCompanyId} />
      ) : view === "symptoms" ? (
        <SymptomsView companyId={selectedCompanyId} />
      ) : view === "medications" ? (
        <MedicationsView companyId={selectedCompanyId} />
      ) : view === "lab-results" ? (
        <LabResultsView companyId={selectedCompanyId} />
      ) : view === "goals" ? (
        <GoalsView companyId={selectedCompanyId} />
      ) : (
        <JournalView companyId={selectedCompanyId} />
      )}
    </div>
  );
}
