import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ReviewViewport = "desktop" | "compact";
type ReviewMode = "split" | "before" | "after";

type ReviewSurface = {
  id: string;
  label: string;
  route: string;
  compact: boolean;
  status: "in-progress" | "verified";
  storyPath?: string;
};

const surfaces: ReviewSurface[] = [
  {
    id: "left-nav-dashboard",
    label: "Global left navigation",
    route: "/TES/dashboard",
    compact: true,
    status: "verified",
    storyPath: "/story/product-navigation-layout--board-chrome-matrix",
  },
  {
    id: "inbox",
    label: "Inbox",
    route: "/TES/inbox/mine",
    compact: true,
    status: "verified",
    storyPath: "/story/pages-inbox-and-tasks-collections--inbox-mine",
  },
  {
    id: "tasks",
    label: "Tasks",
    route: "/TES/issues",
    compact: false,
    status: "verified",
    storyPath: "/story/pages-inbox-and-tasks-collections--tasks",
  },
  {
    id: "activity",
    label: "Activity and Audit",
    route: "/TES/activity",
    compact: false,
    status: "verified",
    storyPath: "/story/design-review-audit-hub--activity-feed",
  },
  {
    id: "task-detail",
    label: "Task detail",
    route: "/TES/issues/TES-1",
    compact: true,
    status: "verified",
    storyPath: "/story/product-task-detail-foundation--relations-panel",
  },
  {
    id: "agent-detail",
    label: "Agent detail",
    route: "/TES/agents/test/overview",
    compact: true,
    status: "verified",
    storyPath: "/story/pages-agent-detail--overview",
  },
  {
    id: "routines",
    label: "Routines",
    route: "/TES/routines",
    compact: true,
    status: "verified",
    storyPath: "/story/product-routines-foundation--active-overview",
  },
  {
    id: "skills",
    label: "Skills",
    route: "/TES/skills",
    compact: true,
    status: "verified",
    storyPath: "/story/skills-store-discovery-grid--installed",
  },
  {
    id: "settings",
    label: "Settings navigation",
    route: "/TES/company/settings",
    compact: true,
    status: "verified",
  },
];

const reviewOrigin = "http://127.0.0.1:3100";

function CapturePanel({
  label,
  src,
  pending,
}: {
  label: string;
  src: string;
  pending?: boolean;
}) {
  const [missing, setMissing] = useState(false);

  return (
    <section className="min-w-0 overflow-hidden border border-border bg-background">
      <header className="flex min-h-10 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">{label}</h2>
        {pending || missing ? (
          <span className="text-xs text-muted-foreground">Capture pending</span>
        ) : null}
      </header>
      <div className="min-h-64 bg-muted/20">
        {pending || missing ? (
          <div className="flex min-h-64 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            The matching After capture appears here after this surface passes its integration gate.
          </div>
        ) : (
          <img
            key={src}
            src={src}
            alt={`${label} UI capture`}
            className="block h-auto w-full"
            onError={() => setMissing(true)}
          />
        )}
      </div>
    </section>
  );
}

function RefactorReviewGallery() {
  const [surfaceId, setSurfaceId] = useState(surfaces[0].id);
  const [viewport, setViewport] = useState<ReviewViewport>("desktop");
  const [mode, setMode] = useState<ReviewMode>("split");

  const surface = useMemo(
    () => surfaces.find((candidate) => candidate.id === surfaceId) ?? surfaces[0],
    [surfaceId],
  );
  const effectiveViewport = viewport === "compact" && !surface.compact ? "desktop" : viewport;
  const beforeSrc = `/review-assets/ui-refactor/before/${effectiveViewport}/${surface.id}.png`;
  const afterSrc = `/review-assets/ui-refactor/after/${effectiveViewport}/${surface.id}.png`;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              UI refactor review
            </p>
            <h1 className="mt-1 text-xl font-semibold">Before and After</h1>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-xs font-medium text-muted-foreground">
              Surface
              <select
                className="h-9 min-w-48 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                value={surfaceId}
                onChange={(event) => setSurfaceId(event.target.value)}
              >
                {surfaces.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Viewport</span>
              <div className="flex gap-1">
                {(["desktop", "compact"] as const).map((candidate) => (
                  <Button
                    key={candidate}
                    type="button"
                    size="sm"
                    variant={effectiveViewport === candidate ? "secondary" : "ghost"}
                    disabled={candidate === "compact" && !surface.compact}
                    onClick={() => setViewport(candidate)}
                  >
                    {candidate === "desktop" ? "Desktop" : "Compact"}
                  </Button>
                ))}
              </div>
            </div>
            <div className="grid gap-1">
              <span className="text-xs font-medium text-muted-foreground">Comparison</span>
              <div className="flex gap-1">
                {(["split", "before", "after"] as const).map((candidate) => (
                  <Button
                    key={candidate}
                    type="button"
                    size="sm"
                    variant={mode === candidate ? "secondary" : "ghost"}
                    onClick={() => setMode(candidate)}
                  >
                    {candidate === "split"
                      ? "Side by side"
                      : candidate === "before"
                        ? "Before"
                        : "After"}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <a href={`${reviewOrigin}${surface.route}`} target="_blank" rel="noreferrer">
              Open live worktree
              <ExternalLink aria-hidden="true" />
            </a>
          </Button>
          {surface.storyPath ? (
            <Button asChild size="sm" variant="ghost">
              <a href={`?path=${surface.storyPath}`} target="_blank" rel="noreferrer">
                Open live component story
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          ) : null}
          <span className="text-xs text-muted-foreground">
            Before is locked. After is recaptured only after independent verification.
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-1 text-xs font-medium",
              surface.status === "verified"
                ? "bg-success/15 text-success"
                : "bg-warning/15 text-warning",
            )}
          >
            {surface.status === "verified" ? "Verified" : "In progress"}
          </span>
        </div>
      </div>

      <div
        className={cn(
          "grid gap-4 p-5",
          mode === "split" ? "xl:grid-cols-2" : "grid-cols-1",
        )}
      >
        {mode !== "after" ? <CapturePanel label="Before" src={beforeSrc} /> : null}
        {mode !== "before" ? <CapturePanel label="After" src={afterSrc} /> : null}
      </div>
    </main>
  );
}

const meta = {
  title: "Refactor Review/Before and After",
  component: RefactorReviewGallery,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof RefactorReviewGallery>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Gallery: Story = {};
