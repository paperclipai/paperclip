import { useEffect, useState } from "react";
import { Activity, AlertCircle, Leaf, MapPin, Pencil, Plus, Sun, Thermometer, Trash2, Wind } from "lucide-react";
import {
  usePersonalEnvironmentalScore,
  type ColorTier,
  type PersonalScoreHistoryEntry,
} from "../hooks/useEnvironmentalScore";
import {
  useLocationsList,
  useAddLocation,
  useEditLocation,
  useDeleteLocation,
  type UserLocation,
} from "../hooks/useLocations";
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

// ---- Location row ----

interface LocationRowProps {
  location: UserLocation;
  companyId: string;
  onEdit: (loc: UserLocation) => void;
}

function LocationRow({ location, companyId, onEdit }: LocationRowProps) {
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

  return (
    <div className="px-4 py-3 flex items-center gap-3 border-b border-border last:border-0">
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
  );
}

// ---- Locations view ----

function LocationsView({ companyId }: { companyId: string }) {
  const { data: locations, isLoading, error } = useLocationsList(companyId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<UserLocation | undefined>(undefined);

  function openAdd() { setEditing(undefined); setDialogOpen(true); }
  function openEdit(loc: UserLocation) { setEditing(loc); setDialogOpen(true); }
  function closeDialog() { setDialogOpen(false); setEditing(undefined); }

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
            <LocationRow key={loc.id} location={loc} companyId={companyId} onEdit={openEdit} />
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

// ---- Page ----

export function Health() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [view, setView] = useState<"score" | "locations">("score");

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
      </div>

      {view === "score" ? (
        <ScoreView companyId={selectedCompanyId} />
      ) : (
        <LocationsView companyId={selectedCompanyId} />
      )}
    </div>
  );
}
