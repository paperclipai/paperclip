import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { WorkTimelineResult } from "@paperclipai/shared";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Timeline } from "@/pages/Timeline";
import {
  WorkTimelineChart,
  clampZoomScale,
  nearestZoomForScale,
  type ZoomLevel,
  zoomScaleForLevel,
} from "@/components/timeline/WorkTimelineChart";
import { Button } from "@/components/ui/button";
import { useCompany } from "@/context/CompanyContext";
import sampleJson from "../fixtures/workTimeline.sample.json";
import humanSampleJson from "../fixtures/workTimeline.human.sample.json";

const COMPANY_ID = "company-storybook";
const STORYBOOK_USER_AVATAR =
  "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=96&q=80";

function withStorybookTimelineDetails(data: WorkTimelineResult): WorkTimelineResult {
  return {
    ...data,
    actors: data.actors.map((actor) => (
      actor.type === "user" ? { ...actor, avatar: STORYBOOK_USER_AVATAR } : actor
    )),
    spans: data.spans.map((span, index) => {
      const inputTokens = 42_000 + index * 137;
      const cachedInputTokens = index % 3 === 0 ? 8_000 : 0;
      const outputTokens = 5_400 + index * 29;
      return {
        ...span,
        usage: span.usage ?? {
          inputTokens,
          cachedInputTokens,
          outputTokens,
          totalTokens: inputTokens + cachedInputTokens + outputTokens,
        },
      };
    }),
  };
}

const sample = withStorybookTimelineDetails(sampleJson as unknown as WorkTimelineResult);
// A second real slice (2026-07-02 14:00–16:00Z) captured straight from the live
// `/timeline` endpoint that DOES carry human events — Dotta's created / commented /
// approved / delegated actions provide human participation and kickoff context.
const humanSample = withStorybookTimelineDetails(humanSampleJson as unknown as WorkTimelineResult);
// The fixture is a real slice of PAP company activity (2026-07-02 14:00–15:50Z);
// pin "now" to the window end so in-progress runs fade correctly.
const NOW = new Date("2026-07-02T15:45:00.000Z").getTime();

function FullPageTimelineHarness() {
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();

  useEffect(() => {
    window.localStorage.setItem("paperclip.selectedCompanyId", COMPANY_ID);
    if (selectedCompanyId !== COMPANY_ID) {
      setSelectedCompanyId(COMPANY_ID);
    }
  }, [selectedCompanyId, setSelectedCompanyId]);

  if (selectedCompanyId !== COMPANY_ID) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <Timeline />
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
  const [zoomScale, setZoomScale] = useState<number | undefined>(undefined);

  const adjustZoom = (factor: number) => {
    const nextScale = clampZoomScale((zoomScale ?? zoomScaleForLevel(zoom)) * factor);
    setZoomScale(nextScale);
    setZoom(nearestZoomForScale(nextScale));
  };

  const resetZoom = () => {
    setZoom(initialZoom);
    setZoomScale(undefined);
  };

  return (
    <div className="min-h-screen bg-background p-6 text-foreground">
      <div className="space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Work Timeline</h1>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-1" aria-label="Timeline zoom controls">
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => adjustZoom(0.8)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={() => adjustZoom(1.25)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-xs"
            onClick={resetZoom}
            aria-label="Reset zoom"
            title="Reset zoom"
          >
            <RotateCcw className="h-3 w-3" />
          </Button>
        </div>

        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-card">
            <WorkTimelineChart
              data={data}
              zoom={zoom}
              zoomScale={zoomScale}
              nowMs={now}
              onZoomScaleChange={(nextScale, nextZoom = nearestZoomForScale(nextScale)) => {
                setZoomScale(nextScale);
                setZoom(nextZoom);
              }}
            />
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

export const FullPageWithMockData: Story = {
  render: () => <FullPageTimelineHarness />,
};
