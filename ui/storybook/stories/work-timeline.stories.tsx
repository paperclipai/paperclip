import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { WorkTimelineChart, type ZoomLevel } from "@/components/timeline/WorkTimelineChart";
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
  data = sample,
  now = NOW,
}: {
  initialZoom?: ZoomLevel;
  data?: WorkTimelineResult;
  now?: number;
}) {
  const [zoom, setZoom] = useState<ZoomLevel>(initialZoom);
  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
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
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card">
            <WorkTimelineChart data={data} zoom={zoom} nowMs={now} />
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

export const HourZoom: Story = { args: { initialZoom: "hour" } };
export const DayZoom: Story = { args: { initialZoom: "day" } };
// Live slice that carries human-originated activity and delegation context.
export const WithHumanActivity: Story = {
  args: {
    initialZoom: "hour",
    data: humanSample,
    now: new Date("2026-07-02T16:00:00.000Z").getTime(),
  },
};
