import { useEffect, useState } from "react";
import { CheckCircle2, Circle, Plus, Repeat, Trash2 } from "lucide-react";
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
import {
  useHabits,
  useHabitCompletions,
  useCreateHabit,
  useCompleteHabit,
  useUncompleteHabit,
  useArchiveHabit,
  type HabitDefinition,
  type HabitCompletion,
} from "../hooks/useHabits";
import { cn } from "@/lib/utils";

const HABIT_COLORS = [
  "#6366f1", "#ec4899", "#f97316", "#eab308",
  "#22c55e", "#06b6d4", "#8b5cf6", "#ef4444",
];

function getDaysInRange(from: string, to: string): string[] {
  const days: string[] = [];
  const d = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  while (d <= end) {
    days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function computeStreak(
  habit: HabitDefinition,
  completionSet: Set<string>,
  today: string,
): number {
  let streak = 0;
  let d = new Date(today + "T00:00:00Z");
  while (true) {
    const dateStr = d.toISOString().slice(0, 10);
    if (completionSet.has(`${habit.id}:${dateStr}`)) {
      streak++;
      d.setUTCDate(d.getUTCDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

interface HabitRowProps {
  habit: HabitDefinition;
  days: string[];
  completionSet: Set<string>;
  streak: number;
  onToggle: (habitId: string, date: string, done: boolean) => void;
  onArchive: (habit: HabitDefinition) => void;
}

function HabitRow({ habit, days, completionSet, streak, onToggle, onArchive }: HabitRowProps) {
  return (
    <div className="flex items-center gap-2 py-2 group">
      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ backgroundColor: habit.color }}
        />
        <span className="text-sm font-medium text-foreground truncate">{habit.name}</span>
        {streak > 0 && (
          <span className="ml-1 text-xs text-amber-600 font-medium shrink-0">🔥 {streak}</span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {days.map((day) => {
          const done = completionSet.has(`${habit.id}:${day}`);
          return (
            <button
              key={day}
              onClick={() => onToggle(habit.id, day, done)}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title={day}
            >
              {done ? (
                <CheckCircle2 className="h-5 w-5" style={{ color: habit.color }} />
              ) : (
                <Circle className="h-5 w-5" />
              )}
            </button>
          );
        })}
      </div>
      <button
        onClick={() => onArchive(habit)}
        className="opacity-0 group-hover:opacity-100 ml-1 text-muted-foreground hover:text-destructive transition-colors shrink-0"
        title="Archive habit"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}

export function Habits() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Habits" }]);
  }, [setBreadcrumbs]);

  const today = new Date().toISOString().slice(0, 10);
  const twoWeeksAgo = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);

  const { data: habitsData, isLoading: habitsLoading } = useHabits(selectedCompanyId ?? undefined);
  const { data: completionsData } = useHabitCompletions(
    selectedCompanyId ?? undefined,
    twoWeeksAgo,
    today,
  );

  const createMutation = useCreateHabit();
  const completeMutation = useCompleteHabit();
  const uncompleteMutation = useUncompleteHabit();
  const archiveMutation = useArchiveHabit();

  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newColor, setNewColor] = useState(HABIT_COLORS[0]);
  const [formError, setFormError] = useState<string | null>(null);

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view habits." />;
  }

  if (habitsLoading) {
    return <PageSkeleton variant="list" />;
  }

  const habits: HabitDefinition[] = habitsData?.habits ?? [];
  const completions: HabitCompletion[] = completionsData?.completions ?? [];

  // Build a fast lookup: "habitId:date"
  const completionSet = new Set(completions.map((c) => `${c.habitId}:${c.completionDate}`));

  const days = getDaysInRange(twoWeeksAgo, today);

  function handleToggle(habitId: string, date: string, done: boolean) {
    if (done) {
      uncompleteMutation.mutate({ habitId, completionDate: date, companyId: selectedCompanyId! });
    } else {
      completeMutation.mutate({ habitId, completionDate: date, companyId: selectedCompanyId! });
    }
  }

  function handleCreate() {
    if (!newName.trim()) {
      setFormError("Habit name is required.");
      return;
    }
    setFormError(null);
    createMutation.mutate(
      { companyId: selectedCompanyId!, name: newName.trim(), description: newDescription.trim() || null, color: newColor },
      {
        onSuccess: () => {
          setShowForm(false);
          setNewName("");
          setNewDescription("");
          setNewColor(HABIT_COLORS[0]);
        },
        onError: (e) => setFormError(e instanceof Error ? e.message : "Failed to create habit."),
      },
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Habits</h1>
          <p className="text-xs text-muted-foreground">Last 14 days</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Habit
        </Button>
      </div>

      {showForm && (
        <Dialog open onOpenChange={(o) => !o && setShowForm(false)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New Habit</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Name *</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Morning meditation"
                  className="w-full border rounded px-2 py-1 text-sm"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Description</label>
                <input
                  type="text"
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Optional description"
                  className="w-full border rounded px-2 py-1 text-sm"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Color</label>
                <div className="flex gap-2 flex-wrap">
                  {HABIT_COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setNewColor(c)}
                      className={cn(
                        "w-6 h-6 rounded-full border-2 transition-all",
                        newColor === c ? "border-foreground scale-110" : "border-transparent",
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleCreate} disabled={createMutation.isPending}>
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {habits.length === 0 ? (
        <EmptyState icon={Repeat} message="No habits yet. Create your first daily habit!" />
      ) : (
        <div className="border rounded-lg">
          {/* Day header row */}
          <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
            <div className="flex-1 text-xs font-medium text-muted-foreground">Habit</div>
            <div className="flex items-center gap-1 shrink-0">
              {days.map((day) => (
                <div key={day} className="w-5 text-center" title={day}>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(day + "T00:00:00Z").toLocaleDateString(undefined, { weekday: "narrow" })}
                  </span>
                </div>
              ))}
            </div>
            <div className="w-4" />
          </div>

          {/* Habit rows */}
          <div className="divide-y px-4">
            {habits.map((habit) => (
              <HabitRow
                key={habit.id}
                habit={habit}
                days={days}
                completionSet={completionSet}
                streak={computeStreak(habit, completionSet, today)}
                onToggle={handleToggle}
                onArchive={(h) =>
                  archiveMutation.mutate({ id: h.id, companyId: selectedCompanyId! })
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
