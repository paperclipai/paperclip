import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { WorkTimelineChart, type ZoomLevel } from "@/components/timeline/WorkTimelineChart";
import { issueColor, type ColorMode } from "@/lib/timeline/layout";
import { cn } from "@/lib/utils";
import sampleJson from "../fixtures/workTimeline.sample.json";
import humanSampleJson from "../fixtures/workTimeline.human.sample.json";

const sample = sampleJson as unknown as WorkTimelineResult;
// A second real slice (2026-07-02 14:00–16:00Z) captured straight from the live
// `/timeline` endpoint that DOES carry human events — Dotta's created / commented /
// approved / delegated actions render as instant diamond markers on her own row.
const humanSample = humanSampleJson as unknown as WorkTimelineResult;
// The fixture is a real slice of PAP company activity (2026-07-02 14:00–15:50Z);
// pin "now" to the window end so in-progress runs fade correctly.
const NOW = new Date("2026-07-02T15:45:00.000Z").getTime();

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border">
      {options.map((opt, i) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          aria-pressed={value === opt.value}
          className={cn(
            "px-3 py-1.5 text-xs",
            i > 0 && "border-l border-border",
            value === opt.value ? "bg-primary text-primary-foreground" : "bg-card text-foreground hover:bg-muted",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function TimelineHarness({
  initialZoom = "day" as ZoomLevel,
  initialColor = "issue" as ColorMode,
  data = sample,
  now = NOW,
}: {
  initialZoom?: ZoomLevel;
  initialColor?: ColorMode;
  data?: WorkTimelineResult;
  now?: number;
}) {
  const [zoom, setZoom] = useState<ZoomLevel>(initialZoom);
  const [colorMode, setColorMode] = useState<ColorMode>(initialColor);
  const issues = Array.from(
    new Map(data.spans.map((s) => [s.issueId, s.issueIdentifier ?? s.issueTitle ?? "task"])).entries(),
  );
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            A Gantt view of who did what, when — real PAP activity (2026-07-02, 14:00–15:50Z). Rows are actors; bars are
            heartbeat runs colored by task; the avatar chip at a bar's leading edge is who kicked it off; straight lines
            are agent→agent delegation. Hover a bar for its task &amp; timing; click to open the task.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Zoom
            <Segmented
              value={zoom}
              onChange={setZoom}
              options={[
                { value: "hour", label: "Hour" },
                { value: "day", label: "Day" },
                { value: "week", label: "Week" },
              ]}
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Color
            <Segmented
              value={colorMode}
              onChange={setColorMode}
              options={[
                { value: "issue", label: "By task" },
                { value: "status", label: "By status" },
              ]}
            />
          </label>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            {colorMode === "issue"
              ? issues.slice(0, 10).map(([id, label]) => (
                  <span key={id} className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-3 w-4 border border-foreground"
                      style={{ borderLeft: `4px solid ${issueColor(id)}` }}
                    />
                    {label}
                  </span>
                ))
              : (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-4 border border-foreground bg-card" /> done
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-3 w-4 border border-foreground"
                      style={{ background: "repeating-linear-gradient(90deg, var(--color-foreground) 0 2px, transparent 2px 5px)" }}
                    />{" "}
                    in&nbsp;progress
                  </span>
                </>
              )}
          </div>
          <div className="rounded-lg border border-border bg-card">
            <WorkTimelineChart data={data} zoom={zoom} colorMode={colorMode} nowMs={now} />
          </div>
          <p className="text-xs text-muted-foreground">
            {data.spans.length} runs · {data.actors.length} actors · {data.events.length} human/instant events · real
            company data
          </p>
        </div>
      </div>
    </div>
  );
}

const meta: Meta<typeof TimelineHarness> = {
  title: "Pages/Work Timeline",
  component: TimelineHarness,
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj<typeof TimelineHarness>;

export const HourByTask: Story = { args: { initialZoom: "hour", initialColor: "issue" } };
export const DayZoom: Story = { args: { initialZoom: "day", initialColor: "issue" } };
export const ByStatus: Story = { args: { initialZoom: "hour", initialColor: "status" } };
// Live slice that carries human events — Dotta gets a row with diamond markers
// for her created / commented / approved / delegated actions (PAP-12444).
export const WithHumanMarkers: Story = {
  args: {
    initialZoom: "hour",
    initialColor: "issue",
    data: humanSample,
    now: new Date("2026-07-02T16:00:00.000Z").getTime(),
  },
};
