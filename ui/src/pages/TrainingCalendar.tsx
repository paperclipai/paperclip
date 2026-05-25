import { useEffect, useMemo, useState } from "react";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "@/lib/utils";

type WorkoutType = "Run" | "Bike" | "Swim" | "Strength" | "Recovery" | "Brick";
type WorkoutStatus = "completed" | "planned" | "missed" | "adapted";
type WorkoutIntensity = "Z1" | "Z2" | "Tempo" | "Threshold" | "VO2";

type Workout = {
  id: string;
  title: string;
  type: WorkoutType;
  durationMinutes: number;
  intensity: WorkoutIntensity;
  tss: number;
  status: WorkoutStatus;
  note: string;
};

type TrainingDay = {
  date: string;
  dayName: string;
  shortDate: string;
  readiness: number;
  workouts: Workout[];
};

type ChatMessage = {
  id: number;
  author: "coach" | "athlete";
  body: string;
  timestamp: string;
};

const week: TrainingDay[] = [
  {
    date: "2026-05-25",
    dayName: "Mon",
    shortDate: "May 25",
    readiness: 82,
    workouts: [
      {
        id: "mon-run",
        title: "Aerobic base run",
        type: "Run",
        durationMinutes: 55,
        intensity: "Z2",
        tss: 58,
        status: "completed",
        note: "Smooth cadence, HR stable.",
      },
    ],
  },
  {
    date: "2026-05-26",
    dayName: "Tue",
    shortDate: "May 26",
    readiness: 76,
    workouts: [
      {
        id: "tue-bike",
        title: "Sweet spot intervals",
        type: "Bike",
        durationMinutes: 75,
        intensity: "Tempo",
        tss: 86,
        status: "adapted",
        note: "Reduced final block after sleep score dipped.",
      },
      {
        id: "tue-strength",
        title: "Core + mobility",
        type: "Strength",
        durationMinutes: 25,
        intensity: "Z1",
        tss: 18,
        status: "completed",
        note: "Keep movement quality high.",
      },
    ],
  },
  {
    date: "2026-05-27",
    dayName: "Wed",
    shortDate: "May 27",
    readiness: 69,
    workouts: [
      {
        id: "wed-swim",
        title: "Technique swim",
        type: "Swim",
        durationMinutes: 45,
        intensity: "Z2",
        tss: 42,
        status: "planned",
        note: "Drills: catch-up, scull, 6x100 relaxed.",
      },
    ],
  },
  {
    date: "2026-05-28",
    dayName: "Thu",
    shortDate: "May 28",
    readiness: 88,
    workouts: [
      {
        id: "thu-run",
        title: "Threshold repeats",
        type: "Run",
        durationMinutes: 65,
        intensity: "Threshold",
        tss: 92,
        status: "planned",
        note: "3x10 min at controlled threshold.",
      },
    ],
  },
  {
    date: "2026-05-29",
    dayName: "Fri",
    shortDate: "May 29",
    readiness: 64,
    workouts: [
      {
        id: "fri-recovery",
        title: "Recovery spin",
        type: "Recovery",
        durationMinutes: 35,
        intensity: "Z1",
        tss: 20,
        status: "planned",
        note: "Optional if fatigue remains elevated.",
      },
    ],
  },
  {
    date: "2026-05-30",
    dayName: "Sat",
    shortDate: "May 30",
    readiness: 73,
    workouts: [
      {
        id: "sat-brick",
        title: "Bike/run brick",
        type: "Brick",
        durationMinutes: 120,
        intensity: "Tempo",
        tss: 138,
        status: "planned",
        note: "Fuel every 25 minutes; run off the bike easy.",
      },
    ],
  },
  {
    date: "2026-05-31",
    dayName: "Sun",
    shortDate: "May 31",
    readiness: 58,
    workouts: [
      {
        id: "sun-long-run",
        title: "Long run",
        type: "Run",
        durationMinutes: 95,
        intensity: "Z2",
        tss: 104,
        status: "missed",
        note: "Missed last week; reassess before rescheduling.",
      },
    ],
  },
];

const initialMessages: ChatMessage[] = [
  {
    id: 1,
    author: "coach",
    body: "Readiness is trending lower into the weekend. Keep Friday truly easy so the brick lands well.",
    timestamp: "08:15",
  },
  {
    id: 2,
    author: "athlete",
    body: "Got it. Should I swap the threshold run if sleep is poor?",
    timestamp: "08:22",
  },
  {
    id: 3,
    author: "coach",
    body: "Yes — if readiness is below 65, convert it to 45 min Z2 and move intervals to next week.",
    timestamp: "08:24",
  },
];

const typeStyles: Record<WorkoutType, string> = {
  Run: "border-l-sky-500 bg-sky-500/10",
  Bike: "border-l-violet-500 bg-violet-500/10",
  Swim: "border-l-cyan-500 bg-cyan-500/10",
  Strength: "border-l-amber-500 bg-amber-500/10",
  Recovery: "border-l-emerald-500 bg-emerald-500/10",
  Brick: "border-l-rose-500 bg-rose-500/10",
};

const statusStyles: Record<WorkoutStatus, string> = {
  completed: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  planned: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  missed: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  adapted: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) return `${remainingMinutes}m`;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

function readinessTone(score: number) {
  if (score >= 80) return "text-emerald-600 dark:text-emerald-300";
  if (score >= 65) return "text-amber-600 dark:text-amber-300";
  return "text-red-600 dark:text-red-300";
}

function statLabel(value: number, suffix = "") {
  return `${Math.round(value)}${suffix}`;
}

function WorkoutCard({ workout }: { workout: Workout }) {
  return (
    <div className={cn("rounded-md border border-l-4 p-3 shadow-sm", typeStyles[workout.type])}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold leading-tight">{workout.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{workout.note}</p>
        </div>
        <Badge variant="outline" className={cn("capitalize", statusStyles[workout.status])}>
          {workout.status}
        </Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <span>{workout.type}</span>
        <span>{formatDuration(workout.durationMinutes)}</span>
        <span>{workout.intensity}</span>
        <span>{workout.tss} TSS</span>
      </div>
    </div>
  );
}

function ReadinessBar({ score }: { score: number }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Readiness</span>
        <span className={cn("font-semibold", readinessTone(score))}>{score}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

export function TrainingCalendar() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Training" }]);
  }, [setBreadcrumbs]);

  const summary = useMemo(() => {
    const workouts = week.flatMap((day) => day.workouts);
    const plannedTss = workouts.reduce((total, workout) => total + workout.tss, 0);
    const completedTss = workouts
      .filter((workout) => workout.status === "completed" || workout.status === "adapted")
      .reduce((total, workout) => total + workout.tss, 0);
    const plannedMinutes = workouts.reduce((total, workout) => total + workout.durationMinutes, 0);
    const completedMinutes = workouts
      .filter((workout) => workout.status === "completed" || workout.status === "adapted")
      .reduce((total, workout) => total + workout.durationMinutes, 0);
    const averageReadiness =
      week.reduce((total, day) => total + day.readiness, 0) / Math.max(week.length, 1);

    return {
      plannedTss,
      completedTss,
      plannedMinutes,
      completedMinutes,
      averageReadiness,
      completionRate: (completedTss / Math.max(plannedTss, 1)) * 100,
    };
  }, []);

  const sendMessage = () => {
    const body = draft.trim();
    if (!body) return;

    setMessages((current) => [
      ...current,
      {
        id: Date.now(),
        author: "athlete",
        body,
        timestamp: "now",
      },
    ]);
    setDraft("");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">TrainingPeaks-inspired planning</p>
          <h1 className="text-3xl font-semibold tracking-tight">Training Calendar</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Weekly view for planned vs completed training load, athlete readiness, and coach chat.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">Previous week</Button>
          <Button>This week</Button>
          <Button variant="outline" asChild>
            <Link to="/training/settings">Configure</Link>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-xl">
          <CardHeader className="pb-0">
            <CardDescription>Weekly load</CardDescription>
            <CardTitle className="text-2xl">{summary.plannedTss} TSS</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {summary.completedTss} TSS completed/adapted so far.
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-0">
            <CardDescription>Planned vs completed</CardDescription>
            <CardTitle className="text-2xl">{statLabel(summary.completionRate, "%")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {formatDuration(summary.completedMinutes)} of {formatDuration(summary.plannedMinutes)} done.
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-0">
            <CardDescription>Athlete readiness</CardDescription>
            <CardTitle className={cn("text-2xl", readinessTone(summary.averageReadiness))}>
              {statLabel(summary.averageReadiness, "%")}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Average across daily recovery signals.
          </CardContent>
        </Card>
        <Card className="rounded-xl">
          <CardHeader className="pb-0">
            <CardDescription>Coach focus</CardDescription>
            <CardTitle className="text-2xl">Manage fatigue</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Keep Friday easy before Saturday's brick session.
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card className="rounded-xl">
          <CardHeader>
            <CardTitle>Week of May 25</CardTitle>
            <CardDescription>7-day grid with workout status, intensity, duration, and TSS.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 lg:grid-cols-7">
              {week.map((day) => (
                <section key={day.date} className="min-h-72 rounded-lg border bg-background/50 p-3">
                  <div className="mb-3 flex items-start justify-between gap-2">
                    <div>
                      <h2 className="font-semibold">{day.dayName}</h2>
                      <p className="text-xs text-muted-foreground">{day.shortDate}</p>
                    </div>
                    <Badge variant="secondary">{day.workouts.length}</Badge>
                  </div>
                  <ReadinessBar score={day.readiness} />
                  <div className="mt-3 space-y-3">
                    {day.workouts.map((workout) => (
                      <WorkoutCard key={workout.id} workout={workout} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle>Load distribution</CardTitle>
              <CardDescription>TSS by discipline</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {(["Run", "Bike", "Swim", "Strength", "Recovery", "Brick"] as WorkoutType[]).map((type) => {
                const tss = week
                  .flatMap((day) => day.workouts)
                  .filter((workout) => workout.type === type)
                  .reduce((total, workout) => total + workout.tss, 0);
                const percentage = (tss / Math.max(summary.plannedTss, 1)) * 100;

                return (
                  <div key={type} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span>{type}</span>
                      <span className="text-muted-foreground">{tss} TSS</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${percentage}%` }} />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card className="rounded-xl">
            <CardHeader>
              <CardTitle>Coach chat</CardTitle>
              <CardDescription>Local page-only conversation</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-h-80 space-y-3 overflow-y-auto rounded-lg border bg-muted/20 p-3">
                {messages.map((message) => (
                  <div
                    key={message.id}
                    className={cn(
                      "rounded-lg border p-3 text-sm",
                      message.author === "athlete"
                        ? "ml-6 bg-primary text-primary-foreground"
                        : "mr-6 bg-background"
                    )}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs opacity-80">
                      <span className="font-medium capitalize">{message.author}</span>
                      <span>{message.timestamp}</span>
                    </div>
                    <p>{message.body}</p>
                  </div>
                ))}
              </div>
              <div className="space-y-2">
                <Input value="Coach Maia" readOnly aria-label="Coach name" />
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Ask about today's workout or request an adjustment..."
                  aria-label="Chat message"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">Ctrl/⌘ + Enter to send</p>
                  <Button onClick={sendMessage} disabled={!draft.trim()}>
                    Send message
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default TrainingCalendar;
