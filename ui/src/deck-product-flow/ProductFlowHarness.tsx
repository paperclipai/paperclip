import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileJson2,
  Frame,
  MonitorPlay,
  PackageCheck,
  ShieldCheck,
} from "lucide-react";
import { AgentCapsule } from "@/components/AgentCapsule";
import { AgentStatusBadge, IssueStatusBadge } from "@/components/StatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DECK_PRODUCT_FLOW_FIXTURE_SOURCE,
  DECK_PRODUCT_FLOW_SEED,
  DECK_PRODUCT_FLOW_VERSION,
  clampDeckProductFlowFrame,
  deckProductFlowFixture,
  type DeckProductFlowArtifact,
  type DeckProductFlowFixture,
} from "./fixtures";

export type DeckProductFlowMode = "capture" | "embed";

export interface DeckProductFlowHarnessProps {
  initialFrame?: number;
  mode?: DeckProductFlowMode;
  fixture?: DeckProductFlowFixture;
  className?: string;
}

function artifactIcon(kind: DeckProductFlowArtifact["kind"]) {
  if (kind === "story") return MonitorPlay;
  if (kind === "image-sequence") return Frame;
  return FileJson2;
}

function artifactStateClass(state: DeckProductFlowArtifact["state"]) {
  if (state === "active") return "border-primary/50 bg-primary/10 text-foreground";
  if (state === "frozen") return "border-border bg-accent/40 text-foreground";
  return "border-border bg-muted/30 text-muted-foreground";
}

function readInitialFrame(initialFrame: number | undefined, frameCount: number) {
  return clampDeckProductFlowFrame(initialFrame ?? 0, frameCount);
}

export function DeckProductFlowHarness({
  initialFrame = 0,
  mode = "capture",
  fixture = deckProductFlowFixture,
  className,
}: DeckProductFlowHarnessProps) {
  const frameCount = fixture.frames.length;
  const [frameIndex, setFrameIndex] = useState(() => readInitialFrame(initialFrame, frameCount));

  useEffect(() => {
    setFrameIndex(readInitialFrame(initialFrame, frameCount));
  }, [frameCount, initialFrame]);

  const frame = fixture.frames[frameIndex] ?? fixture.frames[0]!;
  const activeAgent = fixture.agents.find((agent) => agent.id === frame.activeAgentId) ?? fixture.agents[0]!;
  const activeStageIndex = fixture.stages.findIndex((stage) => stage.id === frame.activeStageId);

  const progressLabel = useMemo(
    () => `${frameIndex + 1} of ${frameCount}`,
    [frameCount, frameIndex],
  );

  const moveFrame = (delta: number) => {
    setFrameIndex((current) => clampDeckProductFlowFrame(current + delta, frameCount));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "embed") return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveFrame(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveFrame(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      setFrameIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setFrameIndex(clampDeckProductFlowFrame(frameCount - 1, frameCount));
    }
  };

  return (
    <main
      data-register="product"
      data-fixture-source={DECK_PRODUCT_FLOW_FIXTURE_SOURCE}
      data-fixture-seed={DECK_PRODUCT_FLOW_SEED}
      data-version={DECK_PRODUCT_FLOW_VERSION}
      data-mode={mode}
      data-app-chrome="none"
      data-deck-product-flow-ready="true"
      className={cn("h-dvh min-h-screen overflow-hidden bg-background text-foreground", className)}
      tabIndex={mode === "embed" ? 0 : undefined}
      aria-label="Paperclip deck product flow harness"
      onKeyDown={handleKeyDown}
    >
      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">Paperclip</span>
              <span aria-hidden="true">/</span>
              <span>{fixture.companyName}</span>
              <span aria-hidden="true">/</span>
              <span className="truncate">{fixture.projectName}</span>
            </div>
            <h1 className="mt-1 truncate text-xl font-semibold tracking-tight">{fixture.issue.title}</h1>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="rounded-md font-mono text-xs">
              Seeded fixture
            </Badge>
            <Badge variant="outline" className="rounded-md font-mono text-xs">
              {fixture.version}
            </Badge>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-12 gap-px bg-border">
          <aside className="col-span-3 min-w-0 bg-card p-4" data-deck-product-flow-panel="context">
            <div className="flex h-full flex-col gap-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{fixture.issue.identifier}</span>
                  <IssueStatusBadge status={frame.issueStatus} />
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    {frame.eyebrow}
                  </p>
                  <p className="mt-2 text-xl font-semibold leading-tight tracking-tight">{frame.headline}</p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{frame.body}</p>
                </div>
              </div>

              <div className="space-y-2">
                {fixture.agents.map((agent) => {
                  const isActive = agent.id === activeAgent.id;
                  return (
                    <div
                      key={agent.id}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-3 py-2",
                        isActive ? "border-primary/40 bg-background" : "border-border bg-background/55",
                      )}
                    >
                      <AgentCapsule
                        state={isActive ? "online" : "configured"}
                        agentName={agent.name}
                        gradient={agent.gradient}
                        size={{ width: 18, height: 44 }}
                        aria-label={`${agent.name} agent capsule`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{agent.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{agent.role}</p>
                      </div>
                      <AgentStatusBadge status={isActive ? "running" : "idle"} />
                    </div>
                  );
                })}
              </div>

              <div className="mt-auto space-y-2 rounded-lg border border-border bg-background/60 p-2">
                <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Boundary
                </div>
                <p className="text-sm leading-5">
                  Slidev gets a static artifact, image sequence, or iframe. React stays outside the Vue tree.
                </p>
              </div>
            </div>
          </aside>

          <div className="col-span-6 min-w-0 bg-background p-4" data-deck-product-flow-panel="flow">
            <div className="flex h-full flex-col">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    Flow frame
                  </p>
                  <p className="text-lg font-semibold">{frame.label}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {frame.focus.map((item) => (
                      <span key={item} className="rounded-md border border-border bg-card px-2 py-1 text-xs">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="font-mono text-xs text-muted-foreground">{progressLabel}</span>
              </div>

              <ol className="grid min-h-0 flex-1 grid-cols-4 gap-3">
                {fixture.stages.map((stage, index) => {
                  const isActive = stage.id === frame.activeStageId;
                  const isPast = index < activeStageIndex;
                  return (
                    <li
                      key={stage.id}
                      aria-current={isActive ? "step" : undefined}
                      className={cn(
                        "flex min-w-0 flex-col rounded-lg border bg-card p-4 transition-colors",
                        isActive && "border-primary/50 bg-primary/10",
                        isPast && "border-border bg-accent/40",
                        !isActive && !isPast && "border-border",
                      )}
                    >
                      <div className="mb-5 flex items-center justify-between gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{String(index + 1).padStart(2, "0")}</span>
                        {isPast ? <CheckCircle2 className="h-4 w-4 text-muted-foreground" /> : null}
                      </div>
                      <p className="text-base font-semibold leading-tight">{stage.label}</p>
                      <p className="mt-2 text-sm leading-6 text-muted-foreground">{stage.detail}</p>
                      <div
                        className={cn(
                          "mt-auto h-1.5 rounded-full bg-muted",
                          (isActive || isPast) && "bg-primary",
                        )}
                      />
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          <aside className="col-span-3 min-w-0 bg-card p-4" data-deck-product-flow-panel="artifact">
            <div className="flex h-full min-w-0 flex-col">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
                    Artifact surface
                  </p>
                  <h2 className="mt-1 text-lg font-semibold">Frozen companion build</h2>
                </div>
                <PackageCheck className="h-5 w-5 text-muted-foreground" />
              </div>

              <div className="mt-5 space-y-3">
                {frame.artifacts.map((artifact) => {
                  const Icon = artifactIcon(artifact.kind);
                  return (
                    <div
                      key={artifact.name}
                      className={cn("min-w-0 rounded-lg border p-3", artifactStateClass(artifact.state))}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs">{artifact.name}</span>
                      </div>
                      <p className="mt-2 text-xs capitalize text-muted-foreground">{artifact.state}</p>
                    </div>
                  );
                })}
              </div>

              <dl className="mt-5 grid min-w-0 gap-2 overflow-hidden rounded-lg border border-border bg-background/60 p-3 text-xs">
                <div className="flex min-w-0 gap-3">
                  <dt className="w-20 shrink-0 text-muted-foreground">Mode</dt>
                  <dd className="min-w-0 flex-1 truncate font-mono">{mode}</dd>
                </div>
                <div className="flex min-w-0 gap-3">
                  <dt className="w-20 shrink-0 text-muted-foreground">Fixture</dt>
                  <dd className="min-w-0 flex-1 truncate font-mono">{fixture.fixtureSource}</dd>
                </div>
                <div className="flex min-w-0 gap-3">
                  <dt className="w-20 shrink-0 text-muted-foreground">Seed</dt>
                  <dd className="min-w-0 flex-1 truncate font-mono">{fixture.seed}</dd>
                </div>
              </dl>

              {mode === "embed" ? (
                <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-4">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => moveFrame(-1)}
                    disabled={frameIndex === 0}
                    aria-label="Previous product flow frame"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Previous
                  </Button>
                  <div className="flex items-center gap-1" aria-label="Product flow frame picker">
                    {fixture.frames.map((candidate, index) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className={cn(
                          "h-2.5 w-2.5 rounded-full border border-border",
                          index === frameIndex ? "bg-foreground" : "bg-muted",
                        )}
                        aria-label={`Show ${candidate.label}`}
                        aria-current={index === frameIndex ? "step" : undefined}
                        onClick={() => setFrameIndex(index)}
                      />
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => moveFrame(1)}
                    disabled={frameIndex === fixture.frames.length - 1}
                    aria-label="Next product flow frame"
                  >
                    Next
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}

export default DeckProductFlowHarness;
